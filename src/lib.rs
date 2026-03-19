use core::{ptr, slice};
use std::mem;

const PARCEL_LEN: usize = 64 * 1024;
const CV_LEN: usize = 32;

// ── Memory helpers ──────────────────────────────────────────

#[no_mangle]
pub extern "C" fn alloc(bytes: usize) -> usize {
    let mut v = Vec::<u8>::with_capacity(bytes);
    let ptr = v.as_mut_ptr() as usize;
    mem::forget(v);
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: usize, bytes: usize) {
    let _ = Vec::<u8>::from_raw_parts(ptr as *mut u8, 0, bytes);
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    CV_LEN
}

// ── Single-parcel hashing ───────────────────────────────────

#[inline]
fn hash_64k_parcel_to_cv(parcel: &[u8], input_offset: u64) -> [u8; CV_LEN] {
    debug_assert!(parcel.len() == PARCEL_LEN);
    blake3::hash_subtree_cv(parcel, input_offset)
}

#[no_mangle]
pub extern "C" fn hash_64k_parcel_to_cv_from_ptr(
    input_ptr: usize,
    input_len: usize,
    input_offset: u64,
    out_ptr: usize,
) {
    let data = unsafe { slice::from_raw_parts(input_ptr as *const u8, input_len) };
    let cv = hash_64k_parcel_to_cv(data, input_offset);
    unsafe {
        ptr::copy_nonoverlapping(cv.as_ptr(), out_ptr as *mut u8, CV_LEN);
    }
}

// ── Batch-parcel hashing ────────────────────────────────────

#[no_mangle]
pub extern "C" fn hash_64k_parcels_to_cvs_from_ptr(
    input_ptr: usize,
    input_len: usize,
    input_offset: u64,
    out_ptr: usize,
    out_len: usize,
) -> usize {
    let input = unsafe { slice::from_raw_parts(input_ptr as *const u8, input_len) };
    let out = unsafe { slice::from_raw_parts_mut(out_ptr as *mut u8, out_len) };
    hash_64k_parcels_to_cvs(input, out, input_offset)
}

#[inline]
fn hash_64k_parcels_to_cvs(input: &[u8], out: &mut [u8], input_offset: u64) -> usize {
    let num_parcels = input.len() / PARCEL_LEN;
    debug_assert!(input.len() % PARCEL_LEN == 0);
    debug_assert!(out.len() >= num_parcels * CV_LEN);

    let mut inp = input.as_ptr();
    let mut outp = out.as_mut_ptr();
    let mut offset = input_offset;

    for _ in 0..num_parcels {
        let parcel = unsafe { slice::from_raw_parts(inp, PARCEL_LEN) };
        let cv = hash_64k_parcel_to_cv(parcel, offset);
        unsafe {
            ptr::copy_nonoverlapping(cv.as_ptr(), outp, CV_LEN);
            inp = inp.add(PARCEL_LEN);
            outp = outp.add(CV_LEN);
        }
        offset = offset.wrapping_add(PARCEL_LEN as u64);
    }
    num_parcels
}

// ── Sizing helpers ──────────────────────────────────────────

#[no_mangle]
pub extern "C" fn num_64k_parcels(input_len: usize) -> usize {
    input_len / PARCEL_LEN
}

#[no_mangle]
pub extern "C" fn bytes_needed_for_64k_parcel_cvs(input_len: usize) -> usize {
    input_len / PARCEL_LEN * CV_LEN
}
