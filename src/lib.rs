use core::{ptr, slice};

const PARCEL_SIZE: usize = 256 * 1024;
const CV_SIZE: usize = 32;

// ── Single-parcel hashing ───────────────────────────────────

#[inline]
fn hash_parcel_to_cv(parcel: &[u8]) -> [u8; CV_SIZE] {
    debug_assert!(parcel.len() == PARCEL_SIZE);
//xxx replace with lower-level hashing
    blake3::hash_subtree_cv(parcel, 0)
}

#[no_mangle]
pub extern "C" fn hash_parcel_to_cv_from_ptr(
    input_ptr: usize,
    out_ptr: usize,
) {
    let data = unsafe { slice::from_raw_parts(input_ptr as *const u8, PARCEL_SIZE) };
    let cv = hash_parcel_to_cv(data);
    unsafe {
        ptr::copy_nonoverlapping(cv.as_ptr(), out_ptr as *mut u8, CV_SIZE);
    }
}

// ── Batch-parcel hashing ────────────────────────────────────

#[no_mangle]
pub extern "C" fn hash_parcels_to_cvs_from_ptr(
    input_ptr: usize,
    input_len: usize,
    out_ptr: usize,
) -> usize {
    let input = unsafe { slice::from_raw_parts(input_ptr as *const u8, input_len) };

    let out_len = input_len / PARCEL_SIZE * CV_SIZE;

    let out = unsafe { slice::from_raw_parts_mut(out_ptr as *mut u8, out_len) };
    hash_parcels_to_cvs(input, out)
}

#[inline]
fn hash_parcels_to_cvs(input: &[u8], out: &mut [u8]) -> usize {
    let num_parcels = input.len() / PARCEL_SIZE;
    debug_assert!(input.len().is_multiple_of(PARCEL_SIZE));
    debug_assert!(out.len() >= num_parcels * CV_SIZE);

    let mut inp = input.as_ptr();
    let mut outp = out.as_mut_ptr();

    for _ in 0..num_parcels {
        let parcel = unsafe { slice::from_raw_parts(inp, PARCEL_SIZE) };
        let cv = hash_parcel_to_cv(parcel);
        unsafe {
            ptr::copy_nonoverlapping(cv.as_ptr(), outp, CV_SIZE);
            inp = inp.add(PARCEL_SIZE);
            outp = outp.add(CV_SIZE);
        }
        inp = unsafe { inp.add(PARCEL_SIZE) };
    }
    num_parcels
}

// ── Sizing helpers ──────────────────────────────────────────

#[no_mangle]
pub extern "C" fn num_64k_parcels(input_len: usize) -> usize {
    input_len / PARCEL_SIZE
}

#[no_mangle]
pub extern "C" fn bytes_needed_for_64k_parcel_cvs(input_len: usize) -> usize {
    input_len / PARCEL_SIZE * CV_SIZE
}
