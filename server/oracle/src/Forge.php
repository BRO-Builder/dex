<?php

declare(strict_types=1);

namespace BroOracle;

/**
 * Local binary encoding of Tezos manager operations (only what the oracle
 * needs: a transaction calling a named entrypoint with a nat parameter).
 */
final class Forge
{
    private const TAG_TRANSACTION = "\x6c";

    /** Unsigned zarith (fees, counters, limits, amounts). */
    public static function nat(int $value): string
    {
        if ($value < 0) {
            throw new \InvalidArgumentException('Negative value for an unsigned number.');
        }
        $out = '';
        do {
            $byte = $value & 0x7f;
            $value >>= 7;
            $out .= chr($value > 0 ? $byte | 0x80 : $byte);
        } while ($value > 0);
        return $out;
    }

    /** Micheline `int` node (tag 0x00 + signed zarith). */
    public static function michelineInt(int $value): string
    {
        $abs = abs($value);
        $byte = $abs & 0x3f;
        if ($value < 0) {
            $byte |= 0x40;
        }
        $abs >>= 6;
        $out = chr($abs > 0 ? $byte | 0x80 : $byte);
        while ($abs > 0) {
            $byte = $abs & 0x7f;
            $abs >>= 7;
            $out .= chr($abs > 0 ? $byte | 0x80 : $byte);
        }
        return "\x00" . $out;
    }

    /** An implicit tz1 account as a public_key_hash. */
    public static function tz1(string $address): string
    {
        return "\x00" . Base58::checkDecode($address, Base58::TZ1, 20);
    }

    /** An originated KT1 contract as a contract_id. */
    public static function kt1(string $address): string
    {
        return "\x01" . Base58::checkDecode($address, Base58::KT1, 20) . "\x00";
    }

    public static function branch(string $blockHash): string
    {
        return Base58::checkDecode($blockHash, Base58::BLOCK, 32);
    }

    /** A named (non-reserved) entrypoint and its Micheline argument. */
    private static function parameters(string $entrypoint, string $micheline): string
    {
        if (strlen($entrypoint) < 1 || strlen($entrypoint) > 31) {
            throw new \InvalidArgumentException('Entrypoint name must be 1-31 characters.');
        }
        return "\xff" . "\xff" . chr(strlen($entrypoint)) . $entrypoint . pack('N', strlen($micheline)) . $micheline;
    }

    /**
     * @param array{source: string, fee: int, counter: int, gas_limit: int, storage_limit: int,
     *              amount: int, destination: string, entrypoint: string, nat: int} $tx
     */
    public static function transaction(array $tx): string
    {
        return self::TAG_TRANSACTION
            . self::tz1($tx['source'])
            . self::nat($tx['fee'])
            . self::nat($tx['counter'])
            . self::nat($tx['gas_limit'])
            . self::nat($tx['storage_limit'])
            . self::nat($tx['amount'])
            . self::kt1($tx['destination'])
            . self::parameters($tx['entrypoint'], self::michelineInt($tx['nat']));
    }

    /** Unsigned operation bytes: branch + one transaction. */
    public static function operation(string $branch, array $tx): string
    {
        return self::branch($branch) . self::transaction($tx);
    }

    /** The same transaction as RPC JSON (for simulation). */
    public static function transactionJson(array $tx): array
    {
        return [
            'kind' => 'transaction',
            'source' => $tx['source'],
            'fee' => (string) $tx['fee'],
            'counter' => (string) $tx['counter'],
            'gas_limit' => (string) $tx['gas_limit'],
            'storage_limit' => (string) $tx['storage_limit'],
            'amount' => (string) $tx['amount'],
            'destination' => $tx['destination'],
            'parameters' => ['entrypoint' => $tx['entrypoint'], 'value' => ['int' => (string) $tx['nat']]],
        ];
    }
}
