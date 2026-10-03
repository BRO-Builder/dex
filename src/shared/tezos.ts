import { useState } from "react";
import { BeaconWallet } from "@taquito/beacon-wallet";
import { TezosToolkit } from "@taquito/taquito";
import { ValidationResult, validateAddress } from "@taquito/utils";

export const NETWORKS = [
  { label: "ShadowNet", value: "shadownet", rpc: "https://rpc.tzkt.io/shadownet", api: "https://api.shadownet.tzkt.io", explorer: "https://shadownet.tzkt.io" },
  { label: "Ghostnet", value: "ghostnet", rpc: "https://rpc.tzkt.io/ghostnet", api: "https://api.ghostnet.tzkt.io", explorer: "https://ghostnet.tzkt.io" },
  { label: "Mainnet", value: "mainnet", rpc: "https://rpc.tzkt.io/mainnet", api: "https://api.tzkt.io", explorer: "https://tzkt.io" },
] as const;

type Network = (typeof NETWORKS)[number];

function getConfiguredNetwork(): Network {
  const value = import.meta.env.VITE_NETWORK;
  return NETWORKS.find((item) => item.value === value) ?? NETWORKS[2];
}

export function isValidAddress(value: string) {
  return validateAddress(value) === ValidationResult.VALID;
}

export function useWallet() {
  const selected = getConfiguredNetwork();
  const network = selected.value;
  const [address, setAddress] = useState<string | null>(null);
  const [toolkit, setToolkit] = useState<TezosToolkit | null>(null);
  const [wallet, setWallet] = useState<BeaconWallet | null>(null);

  async function ensureWallet() {
    const nextToolkit = toolkit ?? new TezosToolkit(selected.rpc);
    nextToolkit.setRpcProvider(selected.rpc);
    const nextWallet = wallet ?? new BeaconWallet({
      name: "BRO Builder DEX",
      iconUrl: "https://www.brobuilder.llc/images/logo2.png",
      network: { type: network as any },
    });
    nextToolkit.setWalletProvider(nextWallet);
    setToolkit(nextToolkit);
    setWallet(nextWallet);
    return { toolkit: nextToolkit, wallet: nextWallet };
  }

  async function connect() {
    const { wallet: nextWallet } = await ensureWallet();
    await nextWallet.requestPermissions();
    setAddress(await nextWallet.getPKH());
  }

  async function disconnect() {
    if (wallet) await wallet.clearActiveAccount();
    setAddress(null);
  }

  return { address, network, selected, connect, disconnect, ensureWallet };
}
