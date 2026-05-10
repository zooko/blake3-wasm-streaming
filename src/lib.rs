#![feature(link_llvm_intrinsics)]
#![allow(clippy::needless_range_loop)] // I prefer needless index instead of iterator and enumerate

// Coded by Claude 4.7 Opus (thinking mode) and me (Zooko)

use blake3::hazmat::{
    merge_subtrees_non_root, merge_subtrees_root, HasherExt,
    Mode,
};
use core::{
    ptr, slice,
    sync::atomic::{AtomicI32, Ordering},
};

const SLICE_SIZE: usize = 16384;
const HALF_SLICE_SIZE: usize = SLICE_SIZE >> 1;
const CV_SIZE: usize = 32;
const NODE_SIZE: usize = CV_SIZE << 1;
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

#[inline(always)]
fn lane_bounds(
    lane: usize, lanes: usize, num_full: usize,
) -> (usize, usize) {
    let base = num_full / lanes;
    let extra = num_full % lanes;
    if lane < extra {
        (lane * (base + 1), base + 1)
    } else {
        (extra + lane * base, base)
    }
}

#[no_mangle]
pub extern "C" fn layout_ctrl_ptr() -> usize {
    let base =
        unsafe { (&__heap_base as *const u8) as usize };
    (base + 15) & !15
}

/// # Safety
/// - `data_ptr` must be valid for reads of `data_len` bytes.
/// - `out_ptr` must be valid for writes of `CV_SIZE` bytes.
/// - The memory regions must not overlap.
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
unsafe fn hash_subtree_cv(
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
unsafe fn hash_full_slice_node(
    data: *const u8, offset: u64, out: *mut u8,
) {
    hash_subtree_cv(data, HALF_SLICE_SIZE, offset, out);
    hash_subtree_cv(
        data.add(HALF_SLICE_SIZE),
        HALF_SLICE_SIZE,
        offset + HALF_SLICE_SIZE as u64,
        out.add(CV_SIZE),
    );
}

#[inline(always)]
unsafe fn node_cv(node: *const u8, out: *mut u8) {
    let merged = merge_subtrees_non_root(
        &*(node as *const [u8; CV_SIZE]),
        &*(node.add(CV_SIZE) as *const [u8; CV_SIZE]),
        Mode::Hash,
    );
    ptr::copy_nonoverlapping(merged.as_ptr(), out, CV_SIZE);
}

#[inline(always)]
unsafe fn node_root(node: *const u8, out: *mut u8) {
    let root = merge_subtrees_root(
        &*(node as *const [u8; CV_SIZE]),
        &*(node.add(CV_SIZE) as *const [u8; CV_SIZE]),
        Mode::Hash,
    );
    ptr::copy_nonoverlapping(root.as_bytes().as_ptr(), out, CV_SIZE);
}

#[inline(always)]
unsafe fn process_lane(
    lane: usize, lanes: usize, num_full: usize,
    data: *const u8, cv: *mut u8,
) {
    let (start, count) = lane_bounds(lane, lanes, num_full);

    let mut p = data.add(start * SLICE_SIZE);
    let mut out = cv.add(start * NODE_SIZE);
    let mut off = (start * SLICE_SIZE) as u64;

    for _ in 0..count {
        hash_full_slice_node(p, off, out);
        p = p.add(SLICE_SIZE);
        out = out.add(NODE_SIZE);
        off += SLICE_SIZE as u64;
    }
}

/// # Safety
/// - `c` must point to a buffer of at least `CTRL_WORDS` i32 values.
/// - `data` must be valid for reads of `len` bytes.
/// - `cv` must be valid for writes of `num_full * NODE_SIZE` bytes,
///   where `num_full = (len & !(SLICE_SIZE - 1)) / SLICE_SIZE`.
/// - `num_threads` must be in `2..=MAX_THREADS`.
/// - All pointers must be properly aligned and refer to shared memory
///   consistent with the worker threads.
#[no_mangle]
pub unsafe extern "C" fn parallel_hash(
    c: *mut i32, data: *const u8, len: u32,
    cv: *mut u8, num_threads: u32,
) {
    let total = len as usize;
    let nt = num_threads as usize;

    assert!((2..=MAX_THREADS).contains(&nt), "nt={}", nt);
    assert!(total >= nt * SLICE_SIZE, "total={} nt={}", total, nt);

    let full = total & !(SLICE_SIZE - 1);
    let num_full = full / SLICE_SIZE;
    assert!(num_full != 0);
    debug_assert!(num_full <= MAX_SLICES);

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
}

/// # Safety
/// - `c` must point to a shared control block of at least `CTRL_WORDS` i32s.
/// - `data` must be valid for reads of the full input buffer.
/// - `cv` must be valid for writes of all produced chaining values.
/// - All memory (`c`, `data`, `cv`) must reside in the same shared linear memory
///   and be concurrently accessible by all participating threads.
/// - `index` must be less than `MAX_THREADS - 1`.
///
/// Memory ordering requirements:
/// - The main thread must publish `NUM_FULL` and `LANES` using `Relaxed` stores
///   before performing a `Release` increment of `WORKER_GEN_BASE + index`.
/// - Each worker performs an `Acquire` load of its generation counter after wake,
///   which synchronizes-with that `Release`, making the prior writes to
///   `NUM_FULL` and `LANES` visible.
/// - The `DONE` counter is incremented with `AcqRel`, and the main thread must
///   observe it using at least `Acquire` semantics (via `Atomics.waitAsync`),
///   ensuring all CV writes are visible before merge.
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

/// # Safety
/// - `node_ptr` must point to `num_full * NODE_SIZE` bytes.
/// - `tail_ptr` must be valid for reads of `tail_len` bytes if `tail_len != 0`.
/// - `out_ptr` must be valid for writes of `CV_SIZE` bytes.
/// - `num_full` must be >= 1.
/// - All pointers must be properly aligned and non-overlapping where required.
#[no_mangle]
pub unsafe extern "C" fn reduce_full_slice_nodes_and_tail(
    node_ptr: *mut u8,
    num_full: u32,
    tail_ptr: *const u8,
    tail_len: u32,
    out_ptr: *mut u8,
) {
    let mut nodes = num_full as usize;
    assert!(nodes != 0);

    let mut has_tail = tail_len != 0;
    let mut tail = [0u8; CV_SIZE];
    let mut left = [0u8; CV_SIZE];
    let mut right = [0u8; CV_SIZE];

    if has_tail {
        hash_subtree_cv(
            tail_ptr,
            tail_len as usize,
            (nodes * SLICE_SIZE) as u64,
            tail.as_mut_ptr(),
        );
    }

    while nodes > 1 {
        let pairs = nodes >> 1;

        for i in 0..pairs {
            let src = node_ptr.add((i << 1) * NODE_SIZE);
            node_cv(src, left.as_mut_ptr());
            node_cv(src.add(NODE_SIZE), right.as_mut_ptr());

            let dst = node_ptr.add(i * NODE_SIZE);
            ptr::copy_nonoverlapping(
                left.as_ptr(), dst, CV_SIZE,
            );
            ptr::copy_nonoverlapping(
                right.as_ptr(), dst.add(CV_SIZE), CV_SIZE,
            );
        }

        let mut next = pairs;

        if (nodes & 1) != 0 {
            let last = node_ptr.add((nodes - 1) * NODE_SIZE);

            if has_tail {
                node_cv(last, left.as_mut_ptr());

                let dst = node_ptr.add(next * NODE_SIZE);
                ptr::copy_nonoverlapping(
                    left.as_ptr(), dst, CV_SIZE,
                );
                ptr::copy_nonoverlapping(
                    tail.as_ptr(), dst.add(CV_SIZE), CV_SIZE,
                );

                next += 1;
                has_tail = false;
            } else {
                ptr::copy_nonoverlapping(
                    last,
                    node_ptr.add(next * NODE_SIZE),
                    NODE_SIZE,
                );
                next += 1;
            }
        }

        nodes = next;
    }

    if has_tail {
        node_cv(node_ptr, left.as_mut_ptr());
        let root =
            merge_subtrees_root(&left, &tail, Mode::Hash);
        ptr::copy_nonoverlapping(
            root.as_bytes().as_ptr(), out_ptr, CV_SIZE,
        );
    } else {
        node_root(node_ptr, out_ptr);
    }
}

fn test_against_known_vectors_quick() {
    const EMPTY_HASH_TEST_VECTOR: [u8; CV_SIZE] = [
        0xaf, 0x13, 0x49, 0xb9, 0xf5, 0xf9, 0xa1, 0xa6,
        0xa0, 0x40, 0x4d, 0xea, 0x36, 0xdc, 0xc9, 0x49,
        0x9b, 0xcb, 0x25, 0xc9, 0xad, 0xc1, 0x12, 0xb7,
        0xcc, 0x9a, 0x93, 0xca, 0xe4, 0x1f, 0x32, 0x62,
    ];

    const INPUT_65_HASH_TEST_VECTOR: [u8; CV_SIZE] = [
        0xde, 0x1e, 0x5f, 0xa0, 0xbe, 0x70, 0xdf, 0x6d,
        0x2b, 0xe8, 0xff, 0xfd, 0x0e, 0x99, 0xce, 0xaa,
        0x8e, 0xb6, 0xe8, 0xc9, 0x3a, 0x63, 0xf2, 0xd8,
        0xd1, 0xc3, 0x0e, 0xcb, 0x6b, 0x26, 0x3d, 0xee,
    ];

    let empty = [];
    let mut out = [0u8; CV_SIZE];
    unsafe {
        blake3_hash(empty.as_ptr(), 0, out.as_mut_ptr());
    }
    assert_eq!(out, EMPTY_HASH_TEST_VECTOR);

    let mut input = [0u8; 65];
    for i in 0..input.len() {
        input[i] = i as u8;
    }
    unsafe {
        blake3_hash(
            input.as_ptr(), input.len(), out.as_mut_ptr(),
        );
    }
    assert_eq!(out, INPUT_65_HASH_TEST_VECTOR);
}

#[test]
fn test_against_known_vectors_thorough() {
    // xxx load test_vectors.json, compare this implementation's output against each one

}

#[test]
fn test_merge_parent_nodes() {
}

#[no_mangle]
pub extern "C" fn quick_startup_self_test() {
    assert_eq!(layout_ctrl_ptr() & 15, 0);

    test_against_known_vectors_quick();
    
    let mut a = [0u8; CV_SIZE];
    let mut b = [0u8; CV_SIZE];
    let mut c = [0u8; CV_SIZE];
    for i in 0..CV_SIZE {
        a[i] = i as u8;
        b[i] = (i as u8).wrapping_mul(3);
        c[i] = 255u8.wrapping_sub(i as u8);
    }

    let mut node = [0u8; NODE_SIZE];
    let mut out = [0u8; CV_SIZE];

    unsafe {
        ptr::copy_nonoverlapping(
            a.as_ptr(), node.as_mut_ptr(), CV_SIZE,
        );
        ptr::copy_nonoverlapping(
            b.as_ptr(),
            node.as_mut_ptr().add(CV_SIZE),
            CV_SIZE,
        );
        node_cv(node.as_ptr(), out.as_mut_ptr());
    }

    let ab = merge_subtrees_non_root(&a, &b, Mode::Hash);
    assert_eq!(out, ab);

    let abc_root = merge_subtrees_root(&ab, &c, Mode::Hash);
    let root2 = merge_subtrees_root(&out, &c, Mode::Hash);
    assert_eq!(root2.as_bytes(), abc_root.as_bytes());

    for lanes in 1..=MAX_THREADS {
        for num_full in 0..=(MAX_THREADS * 2 + 1) {
            let mut next = 0;
            for lane in 0..lanes {
                let (start, count) =
                    lane_bounds(lane, lanes, num_full);
                assert_eq!(start, next);
                next = start + count;
                if lane + 1 != lanes {
                    let (_, next_count) =
                        lane_bounds(lane + 1, lanes, num_full);
                    let diff = count.abs_diff(next_count);
                    assert!(diff <= 1);
                }
            }
            assert_eq!(next, num_full);
        }
    }
}
