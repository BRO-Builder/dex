<?php

declare(strict_types=1);

namespace BroOracle;

/**
 * Pushes the BRO/USD price to BROMarketAssistant.update_price.
 *
 * Price = BRODex `get_price_token_to_xtz(1 BRO)` × Coinbase XTZ/USD, in the
 * ledger's unit: BRO base units per USD cent × 10^6.
 *
 * It pushes only when the price moved by at least `deviationBps` since the
 * on-chain value, or the on-chain value is older than `heartbeatSeconds`.
 */
final class Oracle
{
    private const ENTRYPOINT = 'update_price';
    private const GAS_MARGIN = 100;
    private const STORAGE_MARGIN = 100;
    private const FEE_MARGIN = 100;

    private ?string $chainId = null;

    public function __construct(private Config $config, private Signer $signer)
    {
    }

    /** @return array<string, mixed> result for the HTTP response */
    public function run(bool $dryRun): array
    {
        $lock = fopen("{$this->config->stateDir}/bro-oracle.lock", 'c');
        if ($lock === false) {
            throw new \RuntimeException('Cannot open the lock file in ORACLE_STATE_DIR.');
        }
        if (!flock($lock, LOCK_EX | LOCK_NB)) {
            return ['status' => 'skipped', 'reason' => 'Another run is in progress.'];
        }
        try {
            return $this->runLocked($dryRun);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function runLocked(bool $dryRun): array
    {
        $market = Http::get("{$this->config->tzktUrl}/v1/contracts/{$this->config->marketAddress}/storage");
        if (($market['oracle'] ?? null) !== $this->signer->address()) {
            throw new \RuntimeException('The market assistant\'s oracle is ' . ($market['oracle'] ?? 'unknown')
                . ', not this key\'s address ' . $this->signer->address() . '.');
        }

        $quote = $this->quote();
        $onchain = (int) $market['price'];
        $updatedAt = strtotime((string) $market['price_updated_at']) ?: 0;
        $age = time() - $updatedAt;
        $deviationBps = $onchain > 0 ? intdiv(abs($quote['price'] - $onchain) * 10000, $onchain) : null;

        $result = [
            'network' => $this->config->network,
            'oracle' => $this->signer->address(),
            'price' => $quote['price'],
            'bro_usd' => $quote['bro_usd'],
            'xtz_usd' => $quote['xtz_usd'],
            'onchain_price' => $onchain,
            'onchain_age_seconds' => $age,
            'deviation_bps' => $deviationBps,
        ];

        $reason = match (true) {
            $onchain === 0 => 'No price on-chain yet.',
            $deviationBps >= $this->config->deviationBps => "Price moved {$deviationBps} bps.",
            $age >= $this->config->heartbeatSeconds => "On-chain price is {$age} s old.",
            default => null,
        };
        if ($reason === null) {
            return ['status' => 'skipped', 'reason' => 'Within deviation and heartbeat.'] + $result;
        }

        $state = $this->readState();
        $sinceLast = time() - (int) ($state['pushed_at'] ?? 0);
        if ($sinceLast < $this->config->minPushIntervalSeconds) {
            return ['status' => 'skipped', 'reason' => "Last push ({$state['op_hash']}) was {$sinceLast} s ago and may not be indexed yet."] + $result;
        }
        if ($dryRun) {
            return ['status' => 'dry_run', 'reason' => $reason] + $result;
        }

        $opHash = $this->push($quote['price']);
        $this->writeState(['pushed_at' => time(), 'op_hash' => $opHash, 'price' => $quote['price']]);
        return ['status' => 'pushed', 'reason' => $reason, 'op_hash' => $opHash] + $result;
    }

    /** @return array{price: int, bro_usd: float, xtz_usd: float} */
    private function quote(): array
    {
        $dex = Http::get("{$this->config->tzktUrl}/v1/contracts/{$this->config->dexAddress}/storage");
        $tokens = Http::get("{$this->config->tzktUrl}/v1/tokens?" . http_build_query([
            'contract' => $dex['token_address'],
            'tokenId' => (string) $dex['token_id'],
            'limit' => 1,
        ]));
        $decimals = $tokens[0]['metadata']['decimals'] ?? null;
        if (!is_numeric($decimals) || (int) $decimals < 0 || (int) $decimals > 18) {
            throw new \RuntimeException('BRO token decimals are unavailable from TzKT.');
        }
        $decimals = (int) $decimals;

        $view = Http::post("{$this->config->rpcUrl}/chains/main/blocks/head/helpers/scripts/run_script_view", [
            'contract' => $this->config->dexAddress,
            'view' => 'get_price_token_to_xtz',
            'input' => ['int' => '1' . str_repeat('0', $decimals)],
            'chain_id' => $this->chainId(),
            'unparsing_mode' => 'Readable',
        ]);
        $mutez = (int) ($view['data']['int'] ?? 0);

        $coinbase = Http::get($this->config->coinbaseUrl);
        $xtzUsd = (float) ($coinbase['data']['amount'] ?? 0);

        $broUsd = $mutez / 1e6 * $xtzUsd;
        if (!($mutez > 0) || !($xtzUsd > 0) || !($broUsd > 0)) {
            throw new \RuntimeException('Price inputs are unavailable (DEX quote or XTZ/USD is zero).');
        }
        // BRO base units per cent × 10^6 = 10^decimals × 10^6 / (broUsd × 100)
        $price = (int) round(10 ** $decimals * 10000 / $broUsd);
        if ($price <= 0) {
            throw new \RuntimeException('Computed price is zero.');
        }
        return ['price' => $price, 'bro_usd' => $broUsd, 'xtz_usd' => $xtzUsd];
    }

    private function chainId(): string
    {
        return $this->chainId ??= (string) Http::get("{$this->config->rpcUrl}/chains/main/chain_id");
    }

    /** Simulate, size the limits and fee, sign and inject. Returns the operation hash. */
    private function push(int $price): string
    {
        $rpc = $this->config->rpcUrl;
        $source = $this->signer->address();
        if (Http::get("{$rpc}/chains/main/blocks/head/context/contracts/{$source}/manager_key") === null) {
            throw new \RuntimeException("The oracle account {$source} isn't revealed. Reveal it once from a wallet, then retry.");
        }
        $constants = Http::get("{$rpc}/chains/main/blocks/head/context/constants");
        $branch = (string) Http::get("{$rpc}/chains/main/blocks/head/hash");
        $counter = (int) Http::get("{$rpc}/chains/main/blocks/head/context/contracts/{$source}/counter") + 1;

        $tx = [
            'source' => $source,
            'fee' => 0,
            'counter' => $counter,
            'gas_limit' => (int) $constants['hard_gas_limit_per_operation'],
            'storage_limit' => (int) $constants['hard_storage_limit_per_operation'],
            'amount' => 0,
            'destination' => $this->config->marketAddress,
            'entrypoint' => self::ENTRYPOINT,
            'nat' => $price,
        ];

        $simulation = Http::post("{$rpc}/chains/main/blocks/head/helpers/scripts/simulate_operation", [
            'operation' => [
                'branch' => $branch,
                'contents' => [Forge::transactionJson($tx)],
                'signature' => Base58::checkEncode(Base58::EDSIG, str_repeat("\x00", 64)),
            ],
            'chain_id' => $this->chainId(),
        ]);
        $result = $simulation['contents'][0]['metadata']['operation_result'] ?? [];
        if (($result['status'] ?? null) !== 'applied') {
            throw new \RuntimeException('Simulation failed: ' . json_encode($result['errors'] ?? $result, JSON_UNESCAPED_SLASHES));
        }

        $tx['gas_limit'] = (int) ceil(((int) $result['consumed_milligas']) / 1000) + self::GAS_MARGIN;
        $tx['storage_limit'] = (int) ($result['paid_storage_size_diff'] ?? 0) + self::STORAGE_MARGIN;

        // minimal fee = 100 mutez + 0.1 mutez per gas unit + 1 mutez per byte (signature included)
        $fee = 0;
        for ($i = 0; $i < 3; $i++) {
            $tx['fee'] = $fee;
            $size = strlen(Forge::operation($branch, $tx)) + 64;
            $fee = 100 + (int) ceil($tx['gas_limit'] / 10) + $size + self::FEE_MARGIN;
        }
        $tx['fee'] = $fee;

        $bytes = Forge::operation($branch, $tx);
        $signed = $bytes . $this->signer->sign($bytes);
        $injected = (string) Http::post("{$rpc}/injection/operation?chain=main", bin2hex($signed));
        $expected = Signer::operationHash($signed);
        if ($injected !== $expected) {
            throw new \RuntimeException("Node returned operation hash {$injected}, expected {$expected}.");
        }
        return $injected;
    }

    private function statePath(): string
    {
        return "{$this->config->stateDir}/bro-oracle-state.json";
    }

    private function readState(): array
    {
        $raw = @file_get_contents($this->statePath());
        $state = $raw === false ? null : json_decode($raw, true);
        return is_array($state) ? $state : [];
    }

    private function writeState(array $state): void
    {
        file_put_contents($this->statePath(), json_encode($state), LOCK_EX);
    }
}
