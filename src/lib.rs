#![feature(link_llvm_intrinsics)]
use core::{ptr, slice};
use blake3::hazmat::{HasherExt, merge_subtrees_non_root, merge_subtrees_root, Mode};

const CHUNK_LEN: usize = 1024;
const CV_SIZE: usize = 32;

#[inline(always)]
fn assert_valid_block_size(block: usize) {
    debug_assert!(block.is_power_of_two());
    debug_assert!(block.is_multiple_of(CHUNK_LEN));
}

#[no_mangle]
pub unsafe extern "C" fn blake3_hash(data_ptr: *const u8, data_len: usize, out_ptr: *mut u8) {
    let data = core::slice::from_raw_parts(data_ptr, data_len);
    let hash = blake3::hash(data);
    core::slice::from_raw_parts_mut(out_ptr, CV_SIZE).copy_from_slice(hash.as_bytes());
}

unsafe fn hash_subtree_cv_at(data: *const u8, len: usize, offset: u64, out: *mut u8) {
    debug_assert!(offset.is_multiple_of(CHUNK_LEN as u64));

    let input = slice::from_raw_parts(data, len);
    let mut hasher = blake3::Hasher::new();
    if offset > 0 {
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
    ptr::copy_nonoverlapping(cv.as_ptr(), out, 32);
}

use core::sync::atomic::{AtomicI32, Ordering};

extern "C" {
    #[link_name = "llvm.wasm.memory.atomic.wait32"]
    fn atomic_wait(ptr: *mut i32, exp: i32, timeout: i64) -> i32;
    #[link_name = "llvm.wasm.memory.atomic.notify"]
    fn atomic_notify(ptr: *mut i32, count: u32) -> u32;
}

// ctrl layout: 5 × i32 in shared WASM memory
const GEN: usize = 0;
const CHUNK: usize = 1;
const ACTIVE: usize = 2;
const DONE: usize = 3;
const SIGNAL: usize = 4;

#[inline(always)]
unsafe fn at(c: *mut i32, i: usize) -> &'static AtomicI32 {
    &*(c.add(i) as *const AtomicI32)
}

fn floor_pow2(n: u32) -> u32 {
    if n == 0 { 0 } else { 1 << (31 - n.leading_zeros()) }
}

/// Blocking worker loop. Called once per Web Worker, blocks until GEN == -1.
#[no_mangle]
pub unsafe extern "C" fn worker_loop(
    c: *mut i32, index: u32, data: *const u8, cv: *mut u8,
) {
    let mut last: i32 = 0;
    loop {
        atomic_wait(c.add(GEN), last, -1);
        let gen = at(c, GEN).load(Ordering::Acquire);
        if gen < 0 {
            return;
        }
        last = gen;

        let act = at(c, ACTIVE).load(Ordering::Relaxed) as usize;
        if index as usize >= act {
            continue;
        }

        let chunk = at(c, CHUNK).load(Ordering::Relaxed) as usize;
        let i = index as usize;
        let offset = i * chunk;

        hash_subtree_cv_at(
            data.add(offset),
            chunk,
            offset as u64,
            cv.add(i * CV_SIZE),
        );

        if at(c, DONE).fetch_add(1, Ordering::AcqRel) == act as i32 - 1 {
            at(c, SIGNAL).store(gen, Ordering::Release);
            atomic_notify(c.add(SIGNAL), 1);
        }
    }
}

/// Dispatch parallel hash. Wakes workers, hashes tail on caller.
/// Returns active worker count (0 = single-thread fallback, already done).
#[no_mangle]
pub unsafe extern "C" fn dispatch(
    c: *mut i32, data: *const u8, len: u32, cv: *mut u8,
    workers: u32, min_block: u32,
) -> u32 {
    if workers == 0 {
        blake3_hash(data, len as usize, cv);
        return 0;
    }

    let total = len as usize;

    let mut chunk = floor_pow2(len / workers) as usize;
    if chunk < min_block as usize {
        chunk = min_block as usize;
    }

    assert_valid_block_size(chunk);

    let num_blocks = total.div_ceil(chunk);

    if num_blocks < 2 {
        blake3_hash(data, total, cv);
        return 0;
    }

    let active = core::cmp::min(workers as usize, num_blocks);

    at(c, CHUNK).store(chunk as i32, Ordering::Relaxed);
    at(c, ACTIVE).store(active as i32, Ordering::Relaxed);
    at(c, DONE).store(0, Ordering::Relaxed);
    at(c, GEN).fetch_add(1, Ordering::Release);
    atomic_notify(c.add(GEN), u32::MAX);

    // Caller hashes remaining blocks one-by-one.
    let mut offset = active * chunk;
    let mut cv_idx = active;

    while offset < total {
        let block_len = core::cmp::min(chunk, total - offset);
        hash_subtree_cv_at(
            data.add(offset),
            block_len,
            offset as u64,
            cv.add(cv_idx * CV_SIZE),
        );
        offset += chunk;
        cv_idx += 1;
    }

    cv_idx as u32
}

/// Same split/merge as dispatch, but all on the caller thread (no workers).
#[no_mangle]
pub unsafe extern "C" fn dispatch_st(
    data: *const u8, len: u32, cv: *mut u8,
    workers: u32, min_block: u32,
) -> u32 {
    if workers == 0 {
        blake3_hash(data, len as usize, cv);
        return 0;
    }

    let total = len as usize;

    let mut chunk = floor_pow2(len / workers) as usize;
    if chunk < min_block as usize {
        chunk = min_block as usize;
    }

    assert_valid_block_size(chunk);

    let num_blocks = total.div_ceil(chunk);

    if num_blocks < 2 {
        blake3_hash(data, total, cv);
        return 0;
    }

    let mut offset = 0usize;
    let mut cv_idx = 0usize;

    while offset < total {
        let block_len = core::cmp::min(chunk, total - offset);
        hash_subtree_cv_at(
            data.add(offset),
            block_len,
            offset as u64,
            cv.add(cv_idx * CV_SIZE),
        );
        offset += chunk;
        cv_idx += 1;
    }

    cv_idx as u32
}

/// Merge an array of subtree chaining values into a single root hash.
/// Called from JS after all workers have finished writing their CVs.
#[no_mangle]
pub unsafe extern "C" fn merge_cv_tree(cv_ptr: *mut u8, count: u32, out_ptr: *mut u8) {
    let n = count as usize;
    debug_assert!(n >= 2);

    // Copy CVs to local storage so we can merge in-place
    let mut cvs = [[0u8; 32]; 257]; // max 256 workers + 1 tail
    for i in 0..n {
        ptr::copy_nonoverlapping(cv_ptr.add(i * 32), cvs[i].as_mut_ptr(), 32);
    }

    // Layer-by-layer pairwise merge (matches BLAKE3 tree structure
    // for equal-sized power-of-two subtrees)
    let mut len = n;
    while len > 2 {
        let half = len / 2;
        for i in 0..half {
            cvs[i] = merge_subtrees_non_root(&cvs[2 * i], &cvs[2 * i + 1], Mode::Hash);
        }
        if len % 2 == 1 {
            cvs[half] = cvs[len - 1];
        }
        len = half + len % 2;
    }

    let root = merge_subtrees_root(&cvs[0], &cvs[1], Mode::Hash);
    ptr::copy_nonoverlapping(root.as_bytes().as_ptr(), out_ptr, 32);
}
