use std::{mem, ptr, slice};
use wasm_bindgen::prelude::*;

const OUT_LEN: usize = 32;

#[inline]
fn u64_from_lo_hi(lo: u32, hi: u32) -> u64 {
    (lo as u64) | ((hi as u64) << 32)
}

#[inline]
unsafe fn read_input<'a>(ptr_u32: u32, len_u32: u32) -> &'a [u8] {
    slice::from_raw_parts(ptr_u32 as *const u8, len_u32 as usize)
}

#[inline]
unsafe fn read_cv(ptr_u32: u32) -> [u8; OUT_LEN] {
    let mut out = [0u8; OUT_LEN];
    out.copy_from_slice(slice::from_raw_parts(ptr_u32 as *const u8, OUT_LEN));
    out
}

#[inline]
unsafe fn write32(dst_ptr_u32: u32, src: &[u8; OUT_LEN]) {
    ptr::copy_nonoverlapping(src.as_ptr(), dst_ptr_u32 as *mut u8, OUT_LEN);
}

#[inline]
unsafe fn write_hash(dst_ptr_u32: u32, hash: &blake3::Hash) {
    ptr::copy_nonoverlapping(hash.as_bytes().as_ptr(), dst_ptr_u32 as *mut u8, OUT_LEN);
}

/// Allocate raw bytes in Wasm linear memory and return the pointer.
///
/// Intended usage:
/// - call this during init on one thread,
/// - keep the region for the lifetime of the hasher,
/// - let JS write directly into `memory.buffer` at this pointer.
#[wasm_bindgen]
pub fn alloc(bytes: u32) -> u32 {
    let mut v = Vec::<u8>::with_capacity(bytes as usize);
    let ptr = v.as_mut_ptr() as u32;
    mem::forget(v);
    ptr
}

/// Free a region previously returned by `alloc`.
///
/// `bytes` must match the original capacity passed to `alloc`.
#[wasm_bindgen]
pub unsafe fn dealloc(ptr_u32: u32, bytes: u32) {
    let _ = Vec::<u8>::from_raw_parts(ptr_u32 as *mut u8, 0, bytes as usize);
}

#[wasm_bindgen]
pub fn out_len() -> u32 {
    OUT_LEN as u32
}

/// Hash a legal non-root subtree at `input_offset` and write its 32-byte CV to `out_ptr`.
///
/// Panics if the subtree is illegal for that offset; that is intentional, matching the
/// low-level core API contract.
#[wasm_bindgen]
pub fn hash_subtree_cv_from_ptr(
    input_ptr: u32,
    input_len: u32,
    offset_lo: u32,
    offset_hi: u32,
    out_ptr: u32,
) {
    let input_offset = u64_from_lo_hi(offset_lo, offset_hi);
    let input = unsafe { read_input(input_ptr, input_len) };
    let cv = blake3::hash_subtree_cv(input, input_offset);
    unsafe { write32(out_ptr, &cv) };
}

/// Hash the entire message at `input_ptr,input_len` and write the final 32-byte root hash.
///
/// This should only be used when the bytes at `input_ptr..input_ptr+input_len` are the
/// whole message, not an internal subtree.
#[wasm_bindgen]
pub fn hash_whole_message_root_from_ptr(
    input_ptr: u32,
    input_len: u32,
    out_ptr: u32,
) {
    let input = unsafe { read_input(input_ptr, input_len) };
    let hash = blake3::hash(input);
    unsafe { write_hash(out_ptr, &hash) };
}

/// Merge two child CVs into a non-root parent CV.
#[wasm_bindgen]
pub fn parent_cv_from_ptrs(left_ptr: u32, right_ptr: u32, out_ptr: u32) {
    let left = unsafe { read_cv(left_ptr) };
    let right = unsafe { read_cv(right_ptr) };
    let out = blake3::parent_cv(&left, &right);
    unsafe { write32(out_ptr, &out) };
}

/// Merge two child CVs and finalize them as the root hash.
#[wasm_bindgen]
pub fn root_hash_from_ptrs(left_ptr: u32, right_ptr: u32, out_ptr: u32) {
    let left = unsafe { read_cv(left_ptr) };
    let right = unsafe { read_cv(right_ptr) };
    let out = blake3::root_hash(&left, &right);
    unsafe { write_hash(out_ptr, &out) };
}

#[wasm_bindgen]
pub fn hash_subtree_cv_bytes(input: &[u8], offset_lo: u32, offset_hi: u32) -> Vec<u8> {
    let input_offset = u64_from_lo_hi(offset_lo, offset_hi);
    blake3::hash_subtree_cv(input, input_offset).to_vec()
}

#[wasm_bindgen]
pub fn hash_whole_message_root_bytes(input: &[u8]) -> Vec<u8> {
    blake3::hash(input).as_bytes().to_vec()
}

#[wasm_bindgen]
pub fn parent_cv_bytes(left: &[u8], right: &[u8]) -> Vec<u8> {
    assert_eq!(left.len(), OUT_LEN, "left child CV must be 32 bytes");
    assert_eq!(right.len(), OUT_LEN, "right child CV must be 32 bytes");

    let mut left_arr = [0u8; OUT_LEN];
    let mut right_arr = [0u8; OUT_LEN];
    left_arr.copy_from_slice(left);
    right_arr.copy_from_slice(right);

    blake3::parent_cv(&left_arr, &right_arr).to_vec()
}

#[wasm_bindgen]
pub fn root_hash_bytes(left: &[u8], right: &[u8]) -> Vec<u8> {
    assert_eq!(left.len(), OUT_LEN, "left child CV must be 32 bytes");
    assert_eq!(right.len(), OUT_LEN, "right child CV must be 32 bytes");

    let mut left_arr = [0u8; OUT_LEN];
    let mut right_arr = [0u8; OUT_LEN];
    left_arr.copy_from_slice(left);
    right_arr.copy_from_slice(right);

    blake3::root_hash(&left_arr, &right_arr).as_bytes().to_vec()
}
