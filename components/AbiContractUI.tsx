'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { useSearchParams } from 'next/navigation';
import { SWIPE_REWARDS_ABI } from '@/lib/swipeRewardsAbi';

type AbiFunction = {
  type: 'function';
  name: string;
  stateMutability?: string;
  inputs?: Array<{ name: string; type: string; internalType?: string }>;
};

function isAbiFunction(x: unknown): x is AbiFunction {
  if (!x || typeof x !== 'object') return false;
  const maybe = x as { type?: unknown; name?: unknown };
  return maybe.type === 'function' && typeof maybe.name === 'string';
}

function isView(fn: AbiFunction) {
  return fn.stateMutability === 'view' || fn.stateMutability === 'pure';
}

function serializeResult(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  } catch {
    try {
      return String(value);
    } catch {
      return 'Unserializable result';
    }
  }
}

function coerceValue(type: string, raw: string): unknown {
  if (type === 'address') return raw;
  if (type === 'bool') return raw === 'true' || raw === '1';
  if (type === 'string') return raw;
  if (type.startsWith('uint') || type.startsWith('int')) {
    if (raw === '') return 0;
    return BigInt(raw);
  }
  if (type === 'bytes') return raw;
  if (type.startsWith('bytes')) return raw;
  return raw;
}

async function fetchSignature(address: string, taskType: string, proof?: unknown) {
  const res = await fetch('/api/swipe-signature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, taskType, proof }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success || !data?.signature) {
    throw new Error(data?.error || 'Failed to get signature');
  }
  return data.signature as string;
}

export default function AbiContractUI() {
  const searchParams = useSearchParams();

  const [walletAddress, setWalletAddress] = useState<string>('');
  const [isConnected, setIsConnected] = useState(false);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [chainOk, setChainOk] = useState<boolean | null>(null);

  const [contractAddress, setContractAddress] = useState<string>(
    process.env.NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS ||
      '0x68F12a2fE1fBA2B5bfaED1eA2d844641b95b2dF0'
  );

  const [inputsState, setInputsState] = useState<Record<string, Record<string, string>>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [resultByKey, setResultByKey] = useState<Record<string, string>>({});

  const functions = useMemo(() => {
    const abiItems = [...SWIPE_REWARDS_ABI] as unknown[];
    return abiItems.filter(isAbiFunction);
  }, []);

  const getInjectedEthereum = useCallback((): unknown => {
    if (typeof window === 'undefined') return undefined;
    const w = window as unknown as { ethereum?: unknown };
    return w.ethereum;
  }, []);

  useEffect(() => {
    const contract = searchParams.get('contract');
    if (contract) setContractAddress(contract);

    const taskType = searchParams.get('taskType');
    const achievementType = searchParams.get('achievementType');
    const referrer = searchParams.get('referrer');
    const amount = searchParams.get('amount');
    const castHash = searchParams.get('castHash');

    setInputsState((prev) => {
      const next = { ...prev };
      if (taskType) next.completeTask = { ...(next.completeTask || {}), taskType };
      if (achievementType) next.claimAchievement = { ...(next.claimAchievement || {}), achievementType };
      if (referrer) next.registerReferral = { ...(next.registerReferral || {}), referrer };
      if (amount) next.depositSwipe = { ...(next.depositSwipe || {}), amount };
      if (castHash) next.completeTask = { ...(next.completeTask || {}), castHash };
      return next;
    });
  }, [searchParams]);

  const connect = useCallback(async () => {
    const eth = getInjectedEthereum();
    if (!eth) {
      setResultByKey((p) => ({ ...p, __wallet: 'No injected wallet found (install MetaMask).' }));
      return;
    }

    const p = new ethers.BrowserProvider(eth as ethers.Eip1193Provider);
    await p.send('eth_requestAccounts', []);

    const s = await p.getSigner();
    const addr = await s.getAddress();

    setProvider(p);
    setSigner(s);
    setWalletAddress(addr);
    setIsConnected(true);

    const n = await p.getNetwork();
    setChainOk(Number(n.chainId) === 8453);
  }, [getInjectedEthereum]);

  const disconnect = useCallback(() => {
    setProvider(null);
    setSigner(null);
    setWalletAddress('');
    setIsConnected(false);
    setChainOk(null);
  }, []);

  const contractRead = useMemo(() => {
    if (!provider || !contractAddress) return null;
    try {
      return new ethers.Contract(
        contractAddress,
        SWIPE_REWARDS_ABI as unknown as ethers.InterfaceAbi,
        provider
      );
    } catch {
      return null;
    }
  }, [provider, contractAddress]);

  const contractWrite = useMemo(() => {
    if (!signer || !contractAddress) return null;
    try {
      return new ethers.Contract(
        contractAddress,
        SWIPE_REWARDS_ABI as unknown as ethers.InterfaceAbi,
        signer
      );
    } catch {
      return null;
    }
  }, [signer, contractAddress]);

  const setField = useCallback((fnName: string, field: string, value: string) => {
    setInputsState((prev) => ({
      ...prev,
      [fnName]: {
        ...(prev[fnName] || {}),
        [field]: value,
      },
    }));
  }, []);

  const runFunction = useCallback(
    async (fn: AbiFunction) => {
      const key = fn.name;
      const readOnly = isView(fn);

      if (!contractAddress) {
        setResultByKey((p) => ({ ...p, [key]: 'Contract address is empty' }));
        return;
      }

      const c = readOnly ? contractRead : contractWrite;
      if (!c) {
        setResultByKey((p) => ({ ...p, [key]: readOnly ? 'Provider not ready' : 'Signer not ready' }));
        return;
      }

      setBusyKey(key);
      setResultByKey((p) => ({ ...p, [key]: '' }));

      try {
        const fnInputs = fn.inputs || [];
        const currentInputs = inputsState[key] || {};

        const args: unknown[] = [];
        for (const input of fnInputs) {
          if (input.type === 'address' && input.name === 'user' && !currentInputs[input.name]) {
            if (walletAddress) {
              args.push(walletAddress);
              continue;
            }
          }

          if (input.type === 'bytes' && input.name === 'signature') {
            if (!walletAddress) throw new Error('Wallet not connected');
            const taskType = currentInputs['taskType'] || currentInputs['achievementType'] || '';
            if (!taskType) throw new Error('taskType/achievementType is empty');
            const proof =
              taskType === 'SHARE_CAST' && currentInputs['castHash']
                ? ({ castHash: currentInputs['castHash'] } as const)
                : undefined;
            const sig = await fetchSignature(walletAddress, taskType, proof);
            args.push(sig);
            continue;
          }

          const raw = currentInputs[input.name] ?? '';
          if (raw === '' && input.type !== 'string' && input.type !== 'bytes') {
            args.push(coerceValue(input.type, '0'));
            continue;
          }
          args.push(coerceValue(input.type, raw));
        }

        const cAny = c as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;

        if (readOnly) {
          const res = await cAny[fn.name](...args);
          setResultByKey((p) => ({ ...p, [key]: serializeResult(res) }));
        } else {
          const tx = (await cAny[fn.name](...args)) as unknown as { hash?: string; wait?: () => Promise<unknown> };
          setResultByKey((p) => ({ ...p, [key]: serializeResult({ hash: tx?.hash || tx }) }));
          if (tx?.wait) {
            const receipt = await tx.wait();
            setResultByKey((p) => ({ ...p, [key]: serializeResult(receipt) }));
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setResultByKey((p) => ({ ...p, [key]: msg }));
      } finally {
        setBusyKey(null);
      }
    },
    [contractAddress, contractRead, contractWrite, inputsState, walletAddress]
  );

  const viewFns = functions.filter(isView);
  const writeFns = functions.filter((f) => !isView(f));

  const renderFn = (fn: AbiFunction) => {
    const key = fn.name;
    const readOnly = isView(fn);
    const fnInputs = fn.inputs || [];
    const wantsSignature = fnInputs.some((i) => i.type === 'bytes' && i.name === 'signature');
    const taskType = inputsState[key]?.['taskType'] || '';

    return (
      <div key={key} className="rounded-xl bg-white/5 border border-white/10 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-white font-semibold break-all">{fn.name}</div>
          <button
            className="px-3 py-2 rounded-lg bg-white/10 text-white border border-white/10 hover:bg-white/20 disabled:opacity-50"
            onClick={() => runFunction(fn)}
            disabled={busyKey === key || (!readOnly && !signer) || !contractAddress}
          >
            {busyKey === key ? 'Running...' : readOnly ? 'Call' : 'Send'}
          </button>
        </div>

        {fnInputs.length > 0 && (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
            {fnInputs.map((input) => {
              const val = inputsState[key]?.[input.name] ?? '';
              const placeholder = input.type === 'address' ? '0x...' : input.type;
              const disabled = input.type === 'bytes' && input.name === 'signature';

              return (
                <div key={input.name} className="flex flex-col gap-1">
                  <div className="text-xs text-gray-300">
                    {input.name || '(param)'} : {input.type}
                  </div>
                  <input
                    value={disabled ? '(auto)' : val}
                    disabled={disabled}
                    placeholder={placeholder}
                    onChange={(e) => setField(key, input.name, e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-black/30 text-white border border-white/10 outline-none"
                  />
                </div>
              );
            })}

            {wantsSignature && taskType === 'SHARE_CAST' && (
              <div className="flex flex-col gap-1">
                <div className="text-xs text-gray-300">castHash : string</div>
                <input
                  value={inputsState[key]?.['castHash'] ?? ''}
                  placeholder="0x... (warpcast cast hash)"
                  onChange={(e) => setField(key, 'castHash', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-black/30 text-white border border-white/10 outline-none"
                />
              </div>
            )}
          </div>
        )}

        <div className="mt-3">
          <div className="text-xs text-gray-300">Result</div>
          <pre className="mt-1 text-xs text-white/90 bg-black/30 border border-white/10 rounded-lg p-3 overflow-auto max-h-56">
            {resultByKey[key] || ''}
          </pre>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="text-white text-3xl font-bold">Contract Auto UI</div>
          <div className="text-gray-300 mt-1">Base Mainnet (chainId 8453)</div>
        </div>

        <div className="flex gap-2">
          {!isConnected ? (
            <button
              className="px-4 py-2 rounded-lg bg-white/10 text-white border border-white/10 hover:bg-white/20"
              onClick={connect}
            >
              Connect Wallet
            </button>
          ) : (
            <button
              className="px-4 py-2 rounded-lg bg-white/10 text-white border border-white/10 hover:bg-white/20"
              onClick={disconnect}
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      <div className="rounded-xl bg-white/5 border border-white/10 p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <div className="text-xs text-gray-300">Contract Address</div>
            <input
              value={contractAddress}
              onChange={(e) => setContractAddress(e.target.value)}
              placeholder="0x..."
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/30 text-white border border-white/10 outline-none"
            />
          </div>
          <div>
            <div className="text-xs text-gray-300">Wallet</div>
            <div className="mt-1 px-3 py-2 rounded-lg bg-black/30 text-white border border-white/10 break-all">
              {isConnected ? walletAddress : 'Not connected'}
            </div>
          </div>
        </div>

        <div className="mt-3 text-sm">
          <div className="text-gray-300">Network</div>
          <div className="text-white">
            {chainOk === null ? 'Unknown' : chainOk ? 'OK (Base)' : 'Wrong network (switch to Base)'}
          </div>
        </div>

        {resultByKey.__wallet && (
          <div className="mt-3 text-sm text-red-200">{resultByKey.__wallet}</div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6">
        <div>
          <div className="text-white text-xl font-semibold mb-3">Write</div>
          <div className="grid grid-cols-1 gap-3">{writeFns.map(renderFn)}</div>
        </div>

        <div>
          <div className="text-white text-xl font-semibold mb-3">Read</div>
          <div className="grid grid-cols-1 gap-3">{viewFns.map(renderFn)}</div>
        </div>
      </div>
    </div>
  );
}
