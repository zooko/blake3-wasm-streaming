#![feature(link_llvm_intrinsics)]

use blake3::hazmat::{
    merge_subtrees_non_root,
    merge_subtrees_root,
    HasherExt,
    Mode,
};
use core::{
    ptr,
    slice,
    sync::atomic::{AtomicI32, Ordering},
};

const CHUNK_SIZE: usize = 1024;
const CV_SIZE: usize = 32;

// Total lanes including caller.
const MAX_THREADS: usize = 8;
const BG_WORKERS: usize = MAX_THREADS - 1;

// Planner.
const DIRECT_CUTOFF: usize = 96 * 1024;
const SLICE_64K: usize = 64 * 1024;
const SLICE_128K: usize = 128 * 1024;
const SLICE_256K: usize = 256 * 1024;

const MAX_SLICES: usize = MAX_THREADS * 4;

const ALIGN: usize = 16;

const GEN: usize = 0;
const SLICE_SIZE: usize = 1;
const ACTIVE: usize = 2; // active background workers, not counting caller
const DONE: usize = 3;
const SIGNAL: usize = 4;
const TOTAL_LEN: usize = 5;
const READY: usize = 6;

unsafe extern "C" {
    #[link_name = "llvm.wasm.memory.atomic.wait32"]
    fn atomic_wait(ptr: *mut i32, exp: i32, timeout: i64) -> i32;

    #[link_name = "llvm.wasm.memory.atomic.notify"]
    fn atomic_notify(ptr: *mut i32, count: u32) -> u32;

    static __heap_base: u8;
}

#[inline(always)]
const fn align_up(x: usize, a: usize) -> usize {
    (x + a - 1) & !(a - 1)
}

#[inline(always)]
fn heap_base() -> usize {
    unsafe { (&__heap_base as *const u8) as usize }
}

#[inline(always)]
unsafe fn at(c: *mut i32, i: usize) -> &'static AtomicI32 {
    &*(c.add(i) as *const AtomicI32)
}

#[inline(always)]
fn choose_plan(len: usize) -> (usize, usize) {
    if len < DIRECT_CUTOFF {
        return (0, 0);
    }
    if len < 256 * 1024 {
        return (SLICE_64K, 1);
    }
    if len < 320 * 1024 {
        return (SLICE_64K, 2);
    }
    if len < 384 * 1024 {
        return (SLICE_64K, 3);
    }
    if len < 1024 * 1024 {
        return (SLICE_128K, 2);
    }
    (SLICE_256K, 3)
}

#[inline(always)]
fn full_prefix_len(total: usize, slice_size: usize) -> usize {
    total & !(slice_size - 1)
}

#[inline(always)]
fn leaf_count(total: usize, slice_size: usize) -> usize {
    let full = full_prefix_len(total, slice_size);
    let tail = total - full;
    (full / slice_size) + (tail != 0) as usize
}

// ── Layout export ───────────────────────────────────

#[no_mangle]
pub extern "C" fn layout_ctrl_ptr() -> usize {
    align_up(heap_base(), ALIGN)
}

// ── Single-threaded full hash ───────────────────────────────

#[no_mangle]
pub unsafe extern "C" fn blake3_hash(data_ptr: *const u8, data_len: usize, out_ptr: *mut u8) {
    let data = slice::from_raw_parts(data_ptr, data_len);
    let hash = blake3::hash(data);
    ptr::copy_nonoverlapping(hash.as_bytes().as_ptr(), out_ptr, CV_SIZE);
}

// ── Direct subtree-CV hashing for planner slices ────────────

#[inline(always)]
unsafe fn hash_slice_cv_at(data: *const u8, len: usize, offset: u64, out: *mut u8) {
    assert!(len != 0);
    assert!(offset.is_multiple_of(CHUNK_SIZE as u64));

    let input = slice::from_raw_parts(data, len);
    let mut hasher = blake3::Hasher::new();

    if offset != 0 {
        hasher.set_input_offset(offset);
    }

    hasher.update(input);
    let cv = hasher.finalize_non_root();
    ptr::copy_nonoverlapping(cv.as_ptr(), out, CV_SIZE);
}

#[inline(always)]
unsafe fn process_lane(
    lane: usize,
    lanes: usize,
    slice_size: usize,
    total: usize,
    data: *const u8,
    cv: *mut u8,
) {
    let full = full_prefix_len(total, slice_size);
    let num_full = full / slice_size;
    let tail = total - full;

    let mut slice = lane;
    while slice < num_full {
        let offset = slice * slice_size;
        hash_slice_cv_at(
            data.add(offset),
            slice_size,
            offset as u64,
            cv.add(slice * CV_SIZE),
        );
        slice += lanes;
    }

    if tail != 0 && lane == (num_full % lanes) {
        hash_slice_cv_at(
            data.add(full),
            tail,
            full as u64,
            cv.add(num_full * CV_SIZE),
        );
    }
}

#[inline(always)]
unsafe fn dispatch_direct(
    c: *mut i32,
    data: *const u8,
    total: usize,
    cv: *mut u8,
) -> u32 {
    at(c, SLICE_SIZE).store(0, Ordering::Relaxed);
    at(c, ACTIVE).store(0, Ordering::Relaxed);
    at(c, DONE).store(0, Ordering::Relaxed);
    at(c, TOTAL_LEN).store(total as i32, Ordering::Relaxed);
    blake3_hash(data, total, cv);
    1
}

#[inline(always)]
unsafe fn dispatch_parallel_fixed(
    c: *mut i32,
    data: *const u8,
    total: usize,
    cv: *mut u8,
    slice_size: usize,
    wanted_bg_workers: usize,
) -> u32 {
    if wanted_bg_workers == 0 {
        return dispatch_direct(c, data, total, cv);
    }

    let total_cvs = leaf_count(total, slice_size);
    if total_cvs < 2 {
        return dispatch_direct(c, data, total, cv);
    }

    assert!(slice_size.is_power_of_two());
    assert!(slice_size >= CHUNK_SIZE);

    assert!(total_cvs <= MAX_SLICES);

    let active = core::cmp::min(wanted_bg_workers, total_cvs - 1);
    assert!(active <= BG_WORKERS);

    at(c, SLICE_SIZE).store(slice_size as i32, Ordering::Relaxed);
    at(c, ACTIVE).store(active as i32, Ordering::Relaxed);
    at(c, DONE).store(0, Ordering::Relaxed);
    at(c, TOTAL_LEN).store(total as i32, Ordering::Relaxed);

    at(c, GEN).fetch_add(1, Ordering::AcqRel);
    atomic_notify(c.add(GEN), u32::MAX);

    process_lane(0, active + 1, slice_size, total, data, cv);
    total_cvs as u32
}

// ── Worker loop ─────────────────────────────────────────────

#[no_mangle]
pub unsafe extern "C" fn worker_loop(
    c: *mut i32,
    index: u32,
    data: *const u8,
    cv: *mut u8,
) {
    at(c, READY).fetch_add(1, Ordering::AcqRel);
    atomic_notify(c.add(READY), 1);

    let mut last = at(c, GEN).load(Ordering::Acquire);

    loop {
        atomic_wait(c.add(GEN), last, -1);

        let gen = at(c, GEN).load(Ordering::Acquire);
        if gen < 0 {
            return;
        }
        if gen == last {
            continue;
        }
        last = gen;

        let active = at(c, ACTIVE).load(Ordering::Relaxed) as usize;
        let lanes = active + 1;
        let lane = index as usize + 1;

        if lane >= lanes {
            continue;
        }

        let slice_size = at(c, SLICE_SIZE).load(Ordering::Relaxed) as usize;
        let total = at(c, TOTAL_LEN).load(Ordering::Relaxed) as usize;

        assert!(slice_size.is_power_of_two());
        assert!(slice_size.is_multiple_of(CHUNK_SIZE));

        process_lane(lane, lanes, slice_size, total, data, cv);

        if at(c, DONE).fetch_add(1, Ordering::AcqRel) == active as i32 - 1 {
            at(c, SIGNAL).store(gen, Ordering::Release);
            atomic_notify(c.add(SIGNAL), 1);
        }
    }
}

// ── Planner + dispatch ──────────────────────────────────────

#[no_mangle]
pub unsafe extern "C" fn dispatch(
    c: *mut i32,
    data: *const u8,
    len: u32,
    cv: *mut u8,
    bg_workers: u32,
    min_slice: u32,
) -> u32 {
    let total = len as usize;
    let wanted_bg_workers = bg_workers as usize;
    let mut slice_size = min_slice as usize;

    assert!(wanted_bg_workers <= BG_WORKERS);
    assert!(slice_size.is_power_of_two());
    assert!(slice_size >= CHUNK_SIZE);

    while leaf_count(total, slice_size) > MAX_SLICES {
        slice_size <<= 1;
    }

    dispatch_parallel_fixed(c, data, total, cv, slice_size, wanted_bg_workers)
}

#[no_mangle]
pub unsafe extern "C" fn dispatch_auto(
    c: *mut i32,
    data: *const u8,
    len: u32,
    cv: *mut u8,
) -> u32 {
    let total = len as usize;

    let (slice_size, wanted_bg_workers) = choose_plan(total);

    dispatch_parallel_fixed(c, data, total, cv, slice_size, wanted_bg_workers)
}

// ── Exact root merge for the current plan ───────────────────

#[no_mangle]
pub unsafe extern "C" fn merge_cv_tree(cv_ptr: *mut u8, count: u32, out_ptr: *mut u8) {
    let mut len = count as usize;

    assert!(len >= 2);
    assert!(len <= MAX_SLICES);

    let mut left = [0u8; CV_SIZE];
    let mut right = [0u8; CV_SIZE];

    while len > 2 {
        let half = len >> 1;

        for i in 0..half {
            let src = cv_ptr.add((i << 1) * CV_SIZE);

            ptr::copy_nonoverlapping(src, left.as_mut_ptr(), CV_SIZE);
            ptr::copy_nonoverlapping(src.add(CV_SIZE), right.as_mut_ptr(), CV_SIZE);

            let merged = merge_subtrees_non_root(&left, &right, Mode::Hash);
            ptr::copy_nonoverlapping(merged.as_ptr(), cv_ptr.add(i * CV_SIZE), CV_SIZE);
        }

        if (len & 1) != 0 {
            ptr::copy_nonoverlapping(
                cv_ptr.add((len - 1) * CV_SIZE),
                cv_ptr.add(half * CV_SIZE),
                CV_SIZE,
            );
        }

        len = half + (len & 1);
    }

    ptr::copy_nonoverlapping(cv_ptr, left.as_mut_ptr(), CV_SIZE);
    ptr::copy_nonoverlapping(cv_ptr.add(CV_SIZE), right.as_mut_ptr(), CV_SIZE);

    let root = merge_subtrees_root(&left, &right, Mode::Hash);
    ptr::copy_nonoverlapping(root.as_bytes().as_ptr(), out_ptr, CV_SIZE);
}
