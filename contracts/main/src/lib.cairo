#[starknet::interface]
trait IMainContract<TContractState> {
    fn add_solution(ref self: TContractState, full_proof_with_hints: Span<felt252>);
}

#[starknet::contract]
mod MainContract {
    use starknet::storage::{
        StoragePointerReadAccess, StoragePointerWriteAccess, StoragePathEntry, Map,
    };
    use starknet::{syscalls, SyscallResultTrait};

    const VERIFIER_CLASSHASH: felt252 = 0x079666cdb4fc3cbcafbd74f4ea4e2855bf455c5a7c70915f5679325c54032771;

    #[storage]
    struct Storage {
        // Don't do that for a real use case, use merkle tree instead
        nullifiers: Map<u256, bool>,
    }

    #[abi(embed_v0)]
    impl IMainContractImpl of super::IMainContract<ContractState> {
        fn add_solution(ref self: ContractState, full_proof_with_hints: Span<felt252>) {
            let mut res = syscalls::library_call_syscall(
                VERIFIER_CLASSHASH.try_into().unwrap(),
                selector!("verify_ultra_keccak_honk_proof"),
                full_proof_with_hints
            )
                .unwrap_syscall();
            let public_inputs = Serde::<Option<Span<u256>>>::deserialize(ref res).unwrap().expect('Proof is invalid');

            let nullifier = *public_inputs[0];

            assert(self.nullifiers.entry(nullifier).read() == false, 'Nullifier already used');

            self.nullifiers.entry(nullifier).write(true);
        }
    }
}
