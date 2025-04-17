use std::hash::poseidon;
fn main(x: Field, y: Field, nullifier: pub Field) {
    assert(x != y);
    assert(poseidon::bn254::hash_2([x, y]) == nullifier);
}
