import { useState, useEffect, useRef } from 'react'
import './App.css'
import { ProofState, ProofStateData } from './types'
import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend, reconstructHonkProof } from "@aztec/bb.js";
import { flattenFieldsAsArray } from "./helpers/proof";
import { getHonkCallData, parseHonkProofFromBytes, parseHonkVerifyingKeyFromBytes, init, poseidonHashBN254 } from 'garaga';
import { bytecode, abi } from "./assets/circuit.json";
import { abi as mainAbi } from "./assets/main.json";
import vkUrl from './assets/vk.bin?url';
import { RpcProvider, Contract, Account, constants, WalletAccount, wallet } from 'starknet';
import { connect } from "@starknet-io/get-starknet"
import initNoirC from "@noir-lang/noirc_abi";
import initACVM from "@noir-lang/acvm_js";
import acvm from "@noir-lang/acvm_js/web/acvm_js_bg.wasm?url";
import noirc from "@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm?url";

function App() {
  const [proofState, setProofState] = useState<ProofStateData>({
    state: ProofState.Initial
  });
  const [vk, setVk] = useState<Uint8Array | null>(null);
  const [inputX, setInputX] = useState<number>(6);
  const [inputY, setInputY] = useState<number>(3);
  const [transactionHash, setTransactionHash] = useState<string | null>(null);
  // Use a ref to reliably track the current state across asynchronous operations
  const currentStateRef = useRef<ProofState>(ProofState.Initial);

  // Initialize WASM on component mount
  useEffect(() => {
    const initWasm = async () => {
      try {
        // This might have already been initialized in main.tsx,
        // but we're adding it here as a fallback
        if (typeof window !== 'undefined') {
          await Promise.all([initACVM(fetch(acvm)), initNoirC(fetch(noirc))]);
          console.log('WASM initialization in App component complete');
        }
      } catch (error) {
        console.error('Failed to initialize WASM in App component:', error);
      }
    };

    const loadVk = async () => {
      const response = await fetch(vkUrl);
      const arrayBuffer = await response.arrayBuffer();
      const binaryData = new Uint8Array(arrayBuffer);
      setVk(binaryData);
      console.log('Loaded verifying key:', binaryData);
    };
    
    initWasm();
    loadVk();
  }, []);

  const resetState = () => {
    currentStateRef.current = ProofState.Initial;
    setProofState({
      state: ProofState.Initial,
      error: undefined 
    });
  };

  const handleError = (error: unknown) => {
    console.error('Error:', error);
    let errorMessage: string;
    
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (error !== null && error !== undefined) {
      // Try to convert any non-Error object to a string
      try {
        errorMessage = String(error);
      } catch {
        errorMessage = 'Unknown error (non-stringifiable object)';
      }
    } else {
      errorMessage = 'Unknown error occurred';
    }
    
    // Use the ref to get the most recent state
    setProofState({
      state: currentStateRef.current,
      error: errorMessage
    });
  };

  const updateState = (newState: ProofState) => {
    currentStateRef.current = newState;
    setProofState({ state: newState, error: undefined });
  };

  const startProcess = async () => {
    try {
      // Start the process
      updateState(ProofState.GeneratingWitness);
      
      await init();

      // Use input values from state
      const inputs = {
        x: inputX,
        y: inputY,
        nullifier: poseidonHashBN254(BigInt(inputX), BigInt(inputY)).toString()
      };

      // Generate witness
      let noir = new Noir({ bytecode, abi: abi as any });
      let execResult = await noir.execute(inputs);
      console.log(execResult);
      
      // Generate proof
      updateState(ProofState.GeneratingProof);

      let honk = new UltraHonkBackend(bytecode, { threads: 2 });
      let proof = await honk.generateProof(execResult.witness, { keccak: true });
      honk.destroy();
      console.log(proof);
      
      // Prepare calldata
      updateState(ProofState.PreparingCalldata);

      const rawProof = reconstructHonkProof(flattenFieldsAsArray(proof.publicInputs), proof.proof);
      const honkProof = parseHonkProofFromBytes(rawProof);
      const honkVk = parseHonkVerifyingKeyFromBytes(vk as Uint8Array);
      const callData = getHonkCallData(
        honkProof,
        honkVk,
        0 // HonkFlavor.KECCAK
      );
      console.log(callData);
      
      // Connect wallet
      updateState(ProofState.ConnectingWallet);

      const provider = new RpcProvider({ nodeUrl: 'https://api.cartridge.gg/x/starknet/mainnet' })

      const selectedWalletSWO = await connect();
      if (!selectedWalletSWO) {
        throw new Error('No wallet connected');
      }
      const myWalletAccount = await WalletAccount.connect(
        provider,
        selectedWalletSWO
      );
      console.log(myWalletAccount);
      // Send transaction
      updateState(ProofState.SendingTransaction);

      const contractAddress = '0x0774996d0d13c57c87c68e4ba4cfcd50204a222f183ada14fc1c50957530072c';
      const mainContract = new Contract(mainAbi, contractAddress, myWalletAccount);

      console.log(mainContract);

      // Check verification
      const res = await mainContract.add_solution(callData); // keep the number of elements to pass to the verifier library call
      await provider.waitForTransaction(res.transaction_hash);
      console.log("Transaction hash:", res.transaction_hash);
      setTransactionHash(res.transaction_hash);
      updateState(ProofState.ProofVerified);
    } catch (error) {
      handleError(error);
    }
  };

  const renderStateIndicator = (state: ProofState, current: ProofState) => {
    let status = 'pending';
    
    // If this stage is current with an error, show error state
    if (current === state && proofState.error) {
      status = 'error';
    } 
    // If this is the current stage, show active state
    else if (current === state) {
      status = 'active';
    } 
    // If we're past this stage, mark it completed
    else if (getStateIndex(current) > getStateIndex(state)) {
      status = 'completed';
    }
    
    return (
      <div className={`state-indicator ${status}`}>
        <div className="state-dot"></div>
        <div className="state-label">{state}</div>
      </div>
    );
  };

  const getStateIndex = (state: ProofState): number => {
    const states = [
      ProofState.Initial,
      ProofState.GeneratingWitness,
      ProofState.GeneratingProof,
      ProofState.PreparingCalldata,
      ProofState.ConnectingWallet,
      ProofState.SendingTransaction,
      ProofState.ProofVerified
    ];
    
    return states.indexOf(state);
  };

  return (
    <div className="container">
      <h1>Noir Proof Generation & Starknet Verification</h1>
      
      <div className="state-machine">
        <div className="input-section">
          <div className="input-group">
            <label htmlFor="input-x">X:</label>
            <input 
              id="input-x"
              type="text" 
              value={inputX} 
              onChange={(e) => setInputX(parseInt(e.target.value) || 0)} 
              min="0"
              disabled={proofState.state !== ProofState.Initial}
            />
          </div>
          <div className="input-group">
            <label htmlFor="input-y">Y:</label>
            <input 
              id="input-y"
              type="text" 
              value={inputY} 
              onChange={(e) => setInputY(parseInt(e.target.value) || 0)} 
              min="0"
              disabled={proofState.state !== ProofState.Initial}
            />
          </div>
          <p className="input-hint">Note: X should be different from Y.</p>
        </div>
        
        {renderStateIndicator(ProofState.GeneratingWitness, proofState.state)}
        {renderStateIndicator(ProofState.GeneratingProof, proofState.state)}
        {renderStateIndicator(ProofState.PreparingCalldata, proofState.state)}
        {renderStateIndicator(ProofState.ConnectingWallet, proofState.state)}
        {renderStateIndicator(ProofState.SendingTransaction, proofState.state)}
      </div>
      
      {proofState.error && (
        <div className="error-message">
          Error at stage '{proofState.state}': {proofState.error}
        </div>
      )}

      {proofState.state === ProofState.ProofVerified && (
        <div className="success-message">
          Proof verified successfully! <a href={`https://starkscan.co/tx/${transactionHash}`} target="_blank" rel="noopener noreferrer">View on explorer</a>
        </div>
      )}
      
      <div className="controls">
        {proofState.state === ProofState.Initial && !proofState.error && (
          <button className="primary-button" onClick={startProcess}>Start</button>
        )}
        
        {(proofState.error || proofState.state === ProofState.ProofVerified) && (
          <button className="reset-button" onClick={resetState}>Reset</button>
        )}
      </div>
    </div>
  )
}

export default App
