#![feature(link_llvm_intrinsics)]

use blake3::hazmat::{
    merge_subtrees_non_root, merge_subtrees_root, HasherExt,
    Mode,
};
use core::{
    ptr, slice,
    sync::atomic::{AtomicI32, Ordering},
};

const SLICE_SIZE: usize = 16384;
const CV_SIZE: usize = 32;
const MAX_THREADS: usize = 8;
const MAX_DATA: usize = 1 << 29;
const MAX_SLICES: usize = MAX_DATA / SLICE_SIZE;

const DONE: usize = 0;
const READY: usize = 1;
const NUM_FULL: usize = 2;
const LANES: usize = 3;
const WORKER_GEN_BASE: usize = 4;

unsafe extern "C" {
    #[link_name = "llvm.wasm.memory.atomic.wait32"]
    fn atomic_wait(ptr: *mut i32, exp: i32, timeout: i64)
        -> i32;

    #[link_name = "llvm.wasm.memory.atomic.notify"]
    fn atomic_notify(ptr: *mut i32, count: u32) -> u32;

    static __heap_base: u8;
}

#[inline(always)]
unsafe fn at(c: *mut i32, i: usize) -> &'static AtomicI32 {
    &*(c.add(i) as *const AtomicI32)
}

#[no_mangle]
pub extern "C" fn layout_ctrl_ptr() -> usize {
    let base =
        unsafe { (&__heap_base as *const u8) as usize };
    (base + 15) & !15
}

#[no_mangle]
pub unsafe extern "C" fn blake3_hash(
    data_ptr: *const u8, data_len: usize, out_ptr: *mut u8,
) {
    let data = slice::from_raw_parts(data_ptr, data_len);
    let hash = blake3::hash(data);
    ptr::copy_nonoverlapping(
        hash.as_bytes().as_ptr(), out_ptr, CV_SIZE,
    );
}

#[inline(always)]
unsafe fn hash_slice_cv(
    data: *const u8, len: usize, offset: u64, out: *mut u8,
) {
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
    lane: usize, lanes: usize, num_full: usize,
    data: *const u8, cv: *mut u8,
) {
    let base = num_full / lanes;
    let extra = num_full % lanes;
    let (start, count) = if lane < extra {
        (lane * (base + 1), base + 1)
    } else {
        (extra + lane * base, base)
    };

    let mut p = data.add(start * SLICE_SIZE);
    let mut out = cv.add(start * CV_SIZE);
    let mut off = (start * SLICE_SIZE) as u64;

    for _ in 0..count {
        hash_slice_cv(p, SLICE_SIZE, off, out);
        p = p.add(SLICE_SIZE);
        out = out.add(CV_SIZE);
        off += SLICE_SIZE as u64;
    }
}

#[no_mangle]
pub unsafe extern "C" fn parallel_hash(
    c: *mut i32, data: *const u8, len: u32,
    cv: *mut u8, num_threads: u32,
) {
    let total = len as usize;
    let nt = num_threads as usize;

    assert!(nt >= 2 && nt <= MAX_THREADS);
    assert!(total >= nt * SLICE_SIZE);

    let full = total & !(SLICE_SIZE - 1);
    let num_full = full / SLICE_SIZE;
    let tail = total - full;
    debug_assert!(
        num_full + (tail != 0) as usize <= MAX_SLICES
    );

    let active = nt - 1;

    at(c, DONE).store(0, Ordering::Relaxed);
    at(c, NUM_FULL).store(num_full as i32, Ordering::Relaxed);
    at(c, LANES).store(nt as i32, Ordering::Relaxed);

    for i in 0..active {
        at(c, WORKER_GEN_BASE + i)
            .fetch_add(1, Ordering::Release);
        atomic_notify(c.add(WORKER_GEN_BASE + i), 1);
    }

    process_lane(0, nt, num_full, data, cv);

    if tail != 0 {
        hash_slice_cv(
            data.add(full), tail, full as u64,
            cv.add(num_full * CV_SIZE),
        );
    }
}

#[no_mangle]
pub unsafe extern "C" fn worker_loop(
    c: *mut i32, index: u32,
    data: *const u8, cv: *mut u8,
) {
    at(c, READY).fetch_add(1, Ordering::AcqRel);
    atomic_notify(c.add(READY), 1);

    let gi = WORKER_GEN_BASE + index as usize;
    let mut last = at(c, gi).load(Ordering::Acquire);

    loop {
        atomic_wait(c.add(gi), last, -1);

        let gen = at(c, gi).load(Ordering::Acquire);
        if gen < 0 { return; }
        if gen == last { continue; }
        last = gen;

        let lanes =
            at(c, LANES).load(Ordering::Relaxed) as usize;
        let num_full =
            at(c, NUM_FULL).load(Ordering::Relaxed) as usize;

        debug_assert!(index as usize + 1 < lanes);

        process_lane(
            index as usize + 1, lanes, num_full, data, cv,
        );

        if at(c, DONE).fetch_add(1, Ordering::AcqRel)
            == (lanes - 2) as i32
        {
            atomic_notify(c.add(DONE), 1);
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn merge_cv_tree(
    cv_ptr: *mut u8, count: u32, out_ptr: *mut u8,
) {
    let mut len = count as usize;
    debug_assert!(len >= 2);

    let mut left = [0u8; CV_SIZE];
    let mut right = [0u8; CV_SIZE];

    while len > 2 {
        let half = len >> 1;
        for i in 0..half {
            let src = cv_ptr.add((i << 1) * CV_SIZE);
            ptr::copy_nonoverlapping(
                src, left.as_mut_ptr(), CV_SIZE,
            );
            ptr::copy_nonoverlapping(
                src.add(CV_SIZE), right.as_mut_ptr(), CV_SIZE,
            );
            let merged = merge_subtrees_non_root(
                &left, &right, Mode::Hash,
            );
            ptr::copy_nonoverlapping(
                merged.as_ptr(),
                cv_ptr.add(i * CV_SIZE),
                CV_SIZE,
            );
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

    ptr::copy_nonoverlapping(
        cv_ptr, left.as_mut_ptr(), CV_SIZE,
    );
    ptr::copy_nonoverlapping(
        cv_ptr.add(CV_SIZE), right.as_mut_ptr(), CV_SIZE,
    );
    let root =
        merge_subtrees_root(&left, &right, Mode::Hash);
    ptr::copy_nonoverlapping(
        root.as_bytes().as_ptr(), out_ptr, CV_SIZE,
    );
}
