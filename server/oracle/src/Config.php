<?php

declare(strict_types=1);

namespace BroOracle;

/** Settings from environment variables (getenv, or $_SERVER for Apache SetEnv / FastCGI params). */
final class Config
{
    /** Default endpoints per network; TEZOS_RPC_URL / TZKT_API_URL override them. */
    private const NETWORKS = [
        'mainnet' => ['rpc' => 'https://rpc.tzkt.io/mainnet', 'tzkt' => 'https://api.tzkt.io'],
        'shadownet' => ['rpc' => 'https://rpc.tzkt.io/shadownet', 'tzkt' => 'https://api.shadownet.tzkt.io'],
    ];

    public readonly string $network;
    public readonly string $secretKey;
    public readonly string $httpToken;
    public readonly string $rpcUrl;
    public readonly string $tzktUrl;
    public readonly string $marketAddress;
    public readonly string $dexAddress;
    public readonly string $coinbaseUrl;
    public readonly int $deviationBps;
    public readonly int $heartbeatSeconds;
    public readonly int $minPushIntervalSeconds;
    public readonly string $stateDir;

    public function __construct()
    {
        $this->secretKey = self::required('ORACLE_SECRET_KEY');
        $this->httpToken = self::required('ORACLE_HTTP_TOKEN');
        $this->network = strtolower(self::env('TEZOS_NETWORK') ?? 'mainnet');
        if (!isset(self::NETWORKS[$this->network])) {
            throw new \RuntimeException('TEZOS_NETWORK must be one of: ' . implode(', ', array_keys(self::NETWORKS)) . '.');
        }
        $endpoints = self::NETWORKS[$this->network];
        $this->rpcUrl = rtrim(self::env('TEZOS_RPC_URL') ?? $endpoints['rpc'], '/');
        $this->tzktUrl = rtrim(self::env('TZKT_API_URL') ?? $endpoints['tzkt'], '/');
        $this->marketAddress = self::required('MARKET_ADDRESS');
        $this->dexAddress = self::required('DEX_ADDRESS');
        $this->coinbaseUrl = self::env('COINBASE_URL') ?? 'https://api.coinbase.com/v2/prices/XTZ-USD/spot';
        $this->deviationBps = self::int('PRICE_DEVIATION_BPS', 100);
        $this->heartbeatSeconds = self::int('PRICE_HEARTBEAT_SECONDS', 2700);
        $this->minPushIntervalSeconds = self::int('MIN_PUSH_INTERVAL_SECONDS', 120);
        $this->stateDir = rtrim(self::env('ORACLE_STATE_DIR') ?? sys_get_temp_dir(), '/');

        if (strlen($this->httpToken) < 32) {
            throw new \RuntimeException('ORACLE_HTTP_TOKEN must be at least 32 characters.');
        }
        foreach (['MARKET_ADDRESS' => $this->marketAddress, 'DEX_ADDRESS' => $this->dexAddress] as $name => $address) {
            try {
                Base58::checkDecode($address, Base58::KT1, 20);
            } catch (\InvalidArgumentException) {
                throw new \RuntimeException("{$name} must be a KT1 address.");
            }
        }
    }

    public static function env(string $name): ?string
    {
        $value = getenv($name);
        if ($value === false || $value === '') {
            $value = $_SERVER[$name] ?? $_ENV[$name] ?? null;
        }
        return is_string($value) && $value !== '' ? $value : null;
    }

    private static function required(string $name): string
    {
        $value = self::env($name);
        if ($value === null) {
            throw new \RuntimeException("Missing environment variable {$name}.");
        }
        return $value;
    }

    private static function int(string $name, int $default): int
    {
        $value = self::env($name);
        if ($value === null) {
            return $default;
        }
        if (!ctype_digit($value)) {
            throw new \RuntimeException("{$name} must be a whole number.");
        }
        return (int) $value;
    }
}
