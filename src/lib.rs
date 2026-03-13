use std::{mem, ptr, slice};

use blake3::hazmat::HasherExt;
use blake3::{Hasher, OUT_LEN};
use wasm_bindgen::prelude::*;

pub const PARCEL_LEN: usize = 64 * 1024;
pub const CV_LEN: usize = OUT_LEN;

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

/// Hash each 64 KiB parcel in `input` to a non-root CV and write the CVs
/// consecutively into `out`.
///
/// Parcel i writes to:
///   out[i * 32 .. (i + 1) * 32]
///
/// Parcel i is hashed at logical BLAKE3 offset:
///   input_offset + i * 64 KiB
///
/// Returns the number of CVs written.
///
/// Strict version:
/// - `input.len()` must be a multiple of 64 KiB
/// - `out.len()` must be at least num_parcels * 32
pub fn hash_64k_parcel_cvs(input: &[u8], out: &mut [u8], input_offset: u64) -> usize {
    debug_assert!(input.len().is_multiple_of(PARCEL_LEN), "input length must be a multiple of 64 KiB");
    debug_assert!(u64::MAX - input.len() - input_offset >= 0, "logical BLAKE3 offset overflow");

    let num_parcels = input.len() / PARCEL_LEN;
    let needed_out = num_parcels * CV_LEN;

    debug_assert!(out.len() >= needed_out, "output buffer too small: need {} bytes, got {}", needed_out, out.len());

    for (i, parcel) in input.chunks_exact(PARCEL_LEN).enumerate() {
        let parcel_offset = input_offset.wrapping_add((i as u64) * (PARCEL_LEN as u64));

        let mut hasher = Hasher::new();
        hasher.set_input_offset(parcel_offset);
        hasher.update(parcel);
        let cv = hasher.finalize_non_root();

        unsafe {
            ptr::copy_nonoverlapping(cv.as_ptr(), out.as_mut_ptr().add(i * CV_LEN), CV_LEN);
        }
    }

    num_parcels
}

#[wasm_bindgen]
pub fn hash_64k_parcel_cvs_from_ptr(
    input_ptr: u32,
    input_len: u32,
    input_offset: u64,
    out_ptr: u32,
    out_len: u32,
) -> u32 {
    let input = unsafe { slice::from_raw_parts(input_ptr as *const u8, input_len as usize) };
    let out = unsafe { slice::from_raw_parts_mut(out_ptr as *mut u8, out_len as usize) };
    hash_64k_parcel_cvs(input, out, input_offset) as u32
}

#[wasm_bindgen]
pub fn hash_whole_message_root_from_ptr(input_ptr: u32, input_len: u32, out_ptr: u32) {
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
