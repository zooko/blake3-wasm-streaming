#![feature(link_llvm_intrinsics)]

use blake3::hazmat::{merge_subtrees_non_root, merge_subtrees_root, HasherExt, Mode};
use core::{
    mem,
    ptr, slice,
    sync::atomic::{AtomicI32, Ordering},
};

const CHUNK_LEN: usize = 1024;
const CV_SIZE: usize = 32;

// Public runtime/layout config.
const MAX_DATA: usize = 2_000_000;
const MIN_SLICE: usize = 4 * 1024;
const MAX_THREADS: usize = 4; // total lanes including caller
const BG_WORKERS: usize = MAX_THREADS - 1;
const MAX_SLICES: usize = (MAX_DATA + MIN_SLICE - 1) / MIN_SLICE;

const ALIGN: usize = 16;
const PAGE: usize = 65536;
const STACK_SIZE: usize = 65536;

// ctrl layout: 7 × i32 in shared WASM memory
const CTRL_WORDS: usize = 7;
const CTRL_BYTES: usize = CTRL_WORDS * mem::size_of::<i32>();

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
fn assert_valid_slice_size(slice: usize) {
    debug_assert!(slice >= CHUNK_LEN);
    debug_assert!(slice.is_power_of_two());
    debug_assert!(slice.is_multiple_of(CHUNK_LEN));
}

#[inline(always)]
fn floor_pow2(n: u32) -> u32 {
    if n == 0 {
        0
    } else {
        1 << (31 - n.leading_zeros())
    }
}

// ── Layout/config exports ───────────────────────────────────

#[no_mangle]
pub extern "C" fn layout_ctrl_ptr() -> usize {
    align_up(heap_base(), ALIGN)
}

#[no_mangle]
pub extern "C" fn layout_data_ptr() -> usize {
    align_up(layout_ctrl_ptr() + CTRL_BYTES, ALIGN)
}

#[no_mangle]
pub extern "C" fn layout_out_ptr() -> usize {
    align_up(layout_data_ptr() + MAX_DATA, ALIGN)
}

#[no_mangle]
pub extern "C" fn layout_stacks_base() -> usize {
    align_up(layout_out_ptr() + MAX_SLICES * CV_SIZE, ALIGN)
}

#[no_mangle]
pub extern "C" fn layout_required_pages() -> usize {
    let end = layout_stacks_base() + BG_WORKERS * STACK_SIZE;
    (end + PAGE - 1) / PAGE
}

#[no_mangle]
pub extern "C" fn config_max_data() -> u32 {
    MAX_DATA as u32
}

#[no_mangle]
pub extern "C" fn config_min_slice() -> u32 {
    MIN_SLICE as u32
}

#[no_mangle]
pub extern "C" fn config_max_threads() -> u32 {
    MAX_THREADS as u32
}

#[no_mangle]
pub extern "C" fn config_max_slices() -> u32 {
    MAX_SLICES as u32
}

#[no_mangle]
pub extern "C" fn config_ctrl_words() -> u32 {
    CTRL_WORDS as u32
}

#[no_mangle]
pub extern "C" fn config_stack_size() -> u32 {
    STACK_SIZE as u32
}

#[no_mangle]
pub unsafe extern "C" fn clear_ctrl(ctrl_ptr: *mut i32) {
    ptr::write_bytes(ctrl_ptr, 0, CTRL_WORDS);
}

// ── Single-threaded full hash ───────────────────────────────

#[no_mangle]
pub unsafe extern "C" fn blake3_hash(data_ptr: *const u8, data_len: usize, out_ptr: *mut u8) {
    let data = slice::from_raw_parts(data_ptr, data_len);
    let hash = blake3::hash(data);
    ptr::copy_nonoverlapping(hash.as_bytes().as_ptr(), out_ptr, CV_SIZE);
}

// ── Subtree hashing ─────────────────────────────────────────

unsafe fn hash_subtree_cv_at(data: *const u8, len: usize, offset: u64, out: *mut u8) {
    debug_assert!(offset.is_multiple_of(CHUNK_LEN as u64));

    let input = slice::from_raw_parts(data, len);
    let mut hasher = blake3::Hasher::new();

    if offset != 0 {
        if let Some(max) = blake3::hazmat::max_subtree_len(offset) {
            debug_assert!(
                len as u64 <= max,
                "invalid subtree: offset={} len={} max={}",
                offset,
                len,
                max,
            );
        }
        hasher.set_input_offset(offset);
    }

    hasher.update(input);
    let cv = hasher.finalize_non_root();
    ptr::copy_nonoverlapping(cv.as_ptr(), out, CV_SIZE);
}

/// Background worker loop.
/// Called once from each Web Worker and then blocks forever waiting on GEN.
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
        let worker_lane = index as usize;
        if worker_lane >= active {
            continue;
        }

        let slice_size = at(c, SLICE_SIZE).load(Ordering::Relaxed) as usize;
        let total = at(c, TOTAL_LEN).load(Ordering::Relaxed) as usize;

        // Caller is lane 0.
        // Workers are lanes 1..=active.
        let lanes = active + 1;
        let mut slice = worker_lane + 1;

        while slice * slice_size < total {
            let offset = slice * slice_size;
            let slice_len = core::cmp::min(slice_size, total - offset);

            hash_subtree_cv_at(
                data.add(offset),
                slice_len,
                offset as u64,
                cv.add(slice * CV_SIZE),
            );

            slice += lanes;
        }

        if at(c, DONE).fetch_add(1, Ordering::AcqRel) == active as i32 - 1 {
            at(c, SIGNAL).store(gen, Ordering::Release);
            atomic_notify(c.add(SIGNAL), 1);
        }
    }
}

/// Dispatch a parallel hash job.
/// `workers` means background workers only; caller is an extra lane.
/// Returns number of subtree CVs written.
/// Returns 0 if it fell back to single-threaded hashing.
#[no_mangle]
pub unsafe extern "C" fn dispatch(
    c: *mut i32,
    data: *const u8,
    len: u32,
    cv: *mut u8,
    workers: u32,
    min_slice: u32,
) -> u32 {
    let total = len as usize;

    if workers == 0 {
        blake3_hash(data, total, cv);
        return 0;
    }

    let target_lanes = workers + 1;

    let mut slice_size = floor_pow2(len / target_lanes) as usize;
    if slice_size < min_slice as usize {
        slice_size = min_slice as usize;
    }

    assert_valid_slice_size(slice_size);

    let num_slices = total.div_ceil(slice_size);
    if num_slices < 2 {
        blake3_hash(data, total, cv);
        return 0;
    }

    let active = core::cmp::min(workers as usize, num_slices - 1);

    at(c, SLICE_SIZE).store(slice_size as i32, Ordering::Relaxed);
    at(c, ACTIVE).store(active as i32, Ordering::Relaxed);
    at(c, TOTAL_LEN).store(total as i32, Ordering::Relaxed);
    at(c, DONE).store(0, Ordering::Relaxed);

    let gen = at(c, GEN).fetch_add(1, Ordering::AcqRel) + 1;
    atomic_notify(c.add(GEN), u32::MAX);

    // Caller = lane 0
    let lanes = active + 1;
    let mut slice = 0usize;

    while slice < num_slices {
        let offset = slice * slice_size;
        let slice_len = core::cmp::min(slice_size, total - offset);

        hash_subtree_cv_at(
            data.add(offset),
            slice_len,
            offset as u64,
            cv.add(slice * CV_SIZE),
        );

        slice += lanes;
    }

    if active == 0 {
        at(c, SIGNAL).store(gen, Ordering::Release);
    }

    num_slices as u32
}

/// Merge subtree CVs into one root hash.
/// Assumes CVs are laid out in left-to-right subtree order.
#[no_mangle]
pub unsafe extern "C" fn merge_cv_tree(cv_ptr: *mut u8, count: u32, out_ptr: *mut u8) {
    let n = count as usize;
    debug_assert!(n >= 2);
    debug_assert!(n <= MAX_SLICES);

    let mut cvs = [[0u8; 32]; MAX_SLICES];

    for i in 0..n {
        ptr::copy_nonoverlapping(cv_ptr.add(i * CV_SIZE), cvs[i].as_mut_ptr(), CV_SIZE);
    }

    let mut len = n;
    while len > 2 {
        let half = len / 2;

        for i in 0..half {
            cvs[i] = merge_subtrees_non_root(&cvs[2 * i], &cvs[2 * i + 1], Mode::Hash);
        }

        if len % 2 == 1 {
            cvs[half] = cvs[len - 1];
        }

        len = half + (len % 2);
    }

    let root = merge_subtrees_root(&cvs[0], &cvs[1], Mode::Hash);
    ptr::copy_nonoverlapping(root.as_bytes().as_ptr(), out_ptr, CV_SIZE);
}
