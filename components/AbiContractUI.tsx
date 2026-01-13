'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { useSearchParams } from 'next/navigation';
import { SWIPE_REWARDS_ABI } from '@/lib/swipeRewardsAbi';

const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_HEX = '0x2105';
const EIP7702_PROXY_ADDRESS = '0x7702cb554e6bfb442cb743a7df23154544a7176c';
const BASE_EIP7702_MULTICALL = '0xF5042e6ffaC5a625D4E7848e0b01373D8eB9e222';
const DEFAULT_VALIDATOR_ADDRESS = '0x79A33f950b90C7d07E66950daedf868BD0cDcF96';
const DEFAULT_NEW_IMPLEMENTATION = '0x000100abaad02f1cfC8Bbe32bD5a564817339E72';
const DEFAULT_EXPIRY =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';

type Eip1193ish = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

function isEip1193ish(x: unknown): x is Eip1193ish {
  if (!x || typeof x !== 'object') return false;
  return typeof (x as { request?: unknown }).request === 'function';
}

function parseChainId(chainId: unknown): number | null {
  if (typeof chainId === 'number') return chainId;
  if (typeof chainId === 'string') {
    if (chainId.startsWith('0x')) return Number.parseInt(chainId, 16);
    const n = Number(chainId);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function ensureBaseChain(eth: Eip1193ish) {
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_HEX }] });
  } catch (e: unknown) {
    const code = (e as { code?: unknown })?.code;
    if (code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: BASE_CHAIN_HEX,
            chainName: 'Base Mainnet',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://mainnet.base.org'],
            blockExplorerUrls: ['https://basescan.org'],
          },
        ],
      });
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_HEX }] });
      return;
    }
    throw e;
  }
}

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

  const [inputsState, setInputsState] = useState<Record<string, Record<string, string>>>({
    claimAchievement: { achievementType: 'FOLLOW_SOCIALS' },
    completeTask: { taskType: 'TRADING_VOLUME' },
  });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [resultByKey, setResultByKey] = useState<Record<string, string>>({});
  const [eip7702Busy, setEip7702Busy] = useState(false);
  const [eip7702Result, setEip7702Result] = useState<string>('');
  const [eip7702NewImplementation, setEip7702NewImplementation] = useState<string>(
    DEFAULT_NEW_IMPLEMENTATION
  );
  const [eip7702Validator, setEip7702Validator] = useState<string>(DEFAULT_VALIDATOR_ADDRESS);
  const [eip7702Expiry, setEip7702Expiry] = useState<string>(DEFAULT_EXPIRY);
  const [eip7702Signature, setEip7702Signature] = useState<string>('');
  const [eip7702AllowCrossChainReplay, setEip7702AllowCrossChainReplay] = useState<boolean>(true);

  const functions = useMemo(() => {
    const abiItems = [...SWIPE_REWARDS_ABI] as unknown[];
    return abiItems.filter(isAbiFunction);
  }, []);

  const getInjectedEthereum = useCallback((): unknown => {
    if (typeof window === 'undefined') return undefined;
    const w = window as unknown as { ethereum?: unknown };
    return w.ethereum;
  }, []);

  const disconnect = useCallback(() => {
    setProvider(null);
    setSigner(null);
    setWalletAddress('');
    setIsConnected(false);
    setChainOk(null);
  }, []);

  useEffect(() => {
    const ethUnknown = getInjectedEthereum();
    if (!isEip1193ish(ethUnknown)) return;

    const eth = ethUnknown;

    const handleAccountsChanged = async (...args: unknown[]) => {
      const accounts = args[0];
      if (!Array.isArray(accounts) || accounts.length === 0) {
        disconnect();
        return;
      }

      const first = accounts[0];
      if (typeof first !== 'string') return;

      try {
        const p = new ethers.BrowserProvider(eth as unknown as ethers.Eip1193Provider);
        const s = await p.getSigner();
        const addr = await s.getAddress();
        setProvider(p);
        setSigner(s);
        setWalletAddress(addr);
        setIsConnected(true);
        const n = await p.getNetwork();
        setChainOk(Number(n.chainId) === BASE_CHAIN_ID);
      } catch {
        // ignore
      }
    };

    const handleChainChanged = async (...args: unknown[]) => {
      const chainId = parseChainId(args[0]);
      if (chainId != null) setChainOk(chainId === BASE_CHAIN_ID);

      if (!isConnected) return;
      try {
        const p = new ethers.BrowserProvider(eth as unknown as ethers.Eip1193Provider);
        const s = await p.getSigner();
        const addr = await s.getAddress();
        setProvider(p);
        setSigner(s);
        setWalletAddress(addr);
        setIsConnected(true);
      } catch {
        // ignore
      }
    };

    eth.on?.('accountsChanged', handleAccountsChanged);
    eth.on?.('chainChanged', handleChainChanged);
    return () => {
      eth.removeListener?.('accountsChanged', handleAccountsChanged);
      eth.removeListener?.('chainChanged', handleChainChanged);
    };
  }, [disconnect, getInjectedEthereum, isConnected]);

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
    if (!isEip1193ish(eth)) {
      setResultByKey((p) => ({ ...p, __wallet: 'No injected wallet found (install MetaMask).' }));
      return;
    }

    try {
      await ensureBaseChain(eth);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setResultByKey((p) => ({ ...p, __wallet: msg || 'Failed to switch to Base Mainnet' }));
      return;
    }

    const p = new ethers.BrowserProvider(eth as unknown as ethers.Eip1193Provider);
    await p.send('eth_requestAccounts', []);

    const s = await p.getSigner();
    const addr = await s.getAddress();

    setProvider(p);
    setSigner(s);
    setWalletAddress(addr);
    setIsConnected(true);

    const n = await p.getNetwork();
    setChainOk(Number(n.chainId) === BASE_CHAIN_ID);
  }, [getInjectedEthereum]);

  const runEip7702Delegate = useCallback(async () => {
    setEip7702Busy(true);
    setEip7702Result('');

    try {
      const ethUnknown = getInjectedEthereum();
      if (!isEip1193ish(ethUnknown)) throw new Error('No injected wallet found');

      const eth = ethUnknown;
      await ensureBaseChain(eth);

      if (!walletAddress) throw new Error('Wallet not connected');

      const proxyIface = new ethers.Interface([
        'function setImplementation(address newImplementation, bytes callData, address validator, uint256 expiry, bytes signature, bool allowCrossChainReplay)',
      ]);

      const multicallIface = new ethers.Interface([
        'function multicall((address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient) payable returns ((bool success,bytes returnData)[] returnData)',
      ]);

      const callData = '0x';
      const setImplData = proxyIface.encodeFunctionData('setImplementation', [
        eip7702NewImplementation,
        callData,
        eip7702Validator,
        BigInt(eip7702Expiry),
        (eip7702Signature || '0x') as string,
        eip7702AllowCrossChainReplay,
      ]);

      const multicallData = multicallIface.encodeFunctionData('multicall', [
        [
          {
            target: walletAddress,
            allowFailure: false,
            value: BigInt(0),
            callData: setImplData,
          },
        ],
        ethers.ZeroAddress,
        ethers.ZeroAddress,
      ]);

      const tx = {
        from: walletAddress,
        to: BASE_EIP7702_MULTICALL,
        data: multicallData,
        value: '0x0',
        type: '0x4',
        authorizationList: [
          {
            address: EIP7702_PROXY_ADDRESS,
            chainId: BASE_CHAIN_HEX,
          },
        ],
      } as const;

      const hash = (await eth.request({
        method: 'eth_sendTransaction',
        params: [tx as unknown as Record<string, unknown>],
      })) as unknown;

      setEip7702Result(serializeResult(hash));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setEip7702Result(msg || 'Failed');
    } finally {
      setEip7702Busy(false);
    }
  }, [
    eip7702AllowCrossChainReplay,
    eip7702Expiry,
    eip7702NewImplementation,
    eip7702Signature,
    eip7702Validator,
    getInjectedEthereum,
    walletAddress,
  ]);

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
  const writeFns = useMemo(() => {
    const items = functions.filter((f) => !isView(f));
    const priorityOrder = ['claimDaily', 'registerReferral'];
    const rank = (name: string) => {
      const idx = priorityOrder.indexOf(name);
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };
    return [...items].sort((a, b) => {
      const ra = rank(a.name);
      const rb = rank(b.name);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
  }, [functions]);

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
    <div className="w-full max-w-5xl mx-auto px-4 py-10">
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

      <div className="mt-6 rounded-xl bg-white/5 border border-white/10 p-4">
        <div className="flex flex-col md:flex-row md:items-center gap-3 md:justify-between">
          <div className="text-white">
            <div className="font-semibold">Wallet</div>
            <div className="text-sm text-gray-300 break-all">
              {isConnected ? walletAddress : 'Not connected'}
            </div>
            <div className="text-sm text-gray-300">Chain: {chainOk === null ? '-' : chainOk ? 'Base Mainnet ✓' : 'Wrong network'}</div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-xs text-gray-300">Contract Address</div>
            <input
              value={contractAddress}
              onChange={(e) => setContractAddress(e.target.value)}
              placeholder="0x..."
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/30 text-white border border-white/10 outline-none"
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <div className="text-xs text-gray-300">newImplementation : address</div>
              <input
                value={eip7702NewImplementation}
                onChange={(e) => setEip7702NewImplementation(e.target.value)}
                placeholder="0x..."
                className="w-full px-3 py-2 rounded-lg bg-black/30 text-white border border-white/10 outline-none"
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="text-xs text-gray-300">validator : address</div>
              <input
                value={eip7702Validator}
                onChange={(e) => setEip7702Validator(e.target.value)}
                placeholder="0x..."
                className="w-full px-3 py-2 rounded-lg bg-black/30 text-white border border-white/10 outline-none"
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="text-xs text-gray-300">expiry : uint256</div>
              <input
                value={eip7702Expiry}
                onChange={(e) => setEip7702Expiry(e.target.value)}
                placeholder="1157..."
                className="w-full px-3 py-2 rounded-lg bg-black/30 text-white border border-white/10 outline-none"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-200">
              <input
                type="checkbox"
                checked={eip7702AllowCrossChainReplay}
                onChange={(e) => setEip7702AllowCrossChainReplay(e.target.checked)}
              />
              allowCrossChainReplay
            </label>
          </div>

          <div className="flex flex-col gap-1">
            <div className="text-xs text-gray-300">setImplementation signature : bytes</div>
            <input
              value={eip7702Signature}
              onChange={(e) => setEip7702Signature(e.target.value)}
              placeholder="0x..."
              className="w-full px-3 py-2 rounded-lg bg-black/30 text-white border border-white/10 outline-none"
            />
          </div>

          <button
            className="px-3 py-2 rounded-lg bg-white/10 text-white border border-white/10 hover:bg-white/20 disabled:opacity-50"
            onClick={runEip7702Delegate}
            disabled={!isConnected || !chainOk || eip7702Busy || !eip7702Signature}
          >
            {eip7702Busy ? 'Upgrading (EIP-7702)...' : 'Upgrade / Delegate (EIP-7702)'}
          </button>
          {eip7702Result ? (
            <pre className="text-xs text-gray-200 whitespace-pre-wrap break-words">{eip7702Result}</pre>
          ) : null}
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
