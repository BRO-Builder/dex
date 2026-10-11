<?php

declare(strict_types=1);

namespace BroOracle;

/**
 * Base58check encoding with Tezos prefixes. Pure PHP (no bcmath/gmp).
 */
final class Base58
{
    private const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    public const TZ1 = "\x06\xa1\x9f";
    public const KT1 = "\x02\x5a\x79";
    public const EDPK = "\x0d\x0f\x25\xd9";
    public const EDSK_SEED = "\x0d\x0f\x3a\x07";
    public const EDSK_SECRET = "\x2b\xf6\x4e\x07";
    public const EDSIG = "\x09\xf5\xcd\x86\x12";
    public const BLOCK = "\x01\x34";
    public const OPERATION = "\x05\x74";

    public static function encode(string $bytes): string
    {
        $zeros = strlen($bytes) - strlen(ltrim($bytes, "\x00"));
        $digits = [];
        foreach (str_split(substr($bytes, $zeros)) as $char) {
            $carry = ord($char);
            foreach ($digits as $i => $digit) {
                $carry += $digit << 8;
                $digits[$i] = $carry % 58;
                $carry = intdiv($carry, 58);
            }
            while ($carry > 0) {
                $digits[] = $carry % 58;
                $carry = intdiv($carry, 58);
            }
        }
        $out = str_repeat('1', $zeros);
        for ($i = count($digits) - 1; $i >= 0; $i--) {
            $out .= self::ALPHABET[$digits[$i]];
        }
        return $out;
    }

    public static function decode(string $text): string
    {
        $bytes = [0];
        foreach (str_split($text) as $char) {
            $value = strpos(self::ALPHABET, $char);
            if ($value === false) {
                throw new \InvalidArgumentException('Invalid base58 character.');
            }
            $carry = $value;
            foreach ($bytes as $i => $byte) {
                $carry += $byte * 58;
                $bytes[$i] = $carry & 0xff;
                $carry >>= 8;
            }
            while ($carry > 0) {
                $bytes[] = $carry & 0xff;
                $carry >>= 8;
            }
        }
        $out = '';
        for ($i = 0; $i < strlen($text) && $text[$i] === '1'; $i++) {
            $out .= "\x00";
        }
        $body = '';
        for ($i = count($bytes) - 1; $i >= 0; $i--) {
            $body .= chr($bytes[$i]);
        }
        return $out . ltrim($body, "\x00");
    }

    public static function checkEncode(string $prefix, string $payload): string
    {
        $data = $prefix . $payload;
        return self::encode($data . self::checksum($data));
    }

    /** Decode and strip `$prefix`, checking the checksum and payload length. */
    public static function checkDecode(string $text, string $prefix, int $length): string
    {
        $raw = self::decode($text);
        if (strlen($raw) < 4) {
            throw new \InvalidArgumentException('Base58check value is too short.');
        }
        $data = substr($raw, 0, -4);
        if (!hash_equals(self::checksum($data), substr($raw, -4))) {
            throw new \InvalidArgumentException('Base58check checksum mismatch.');
        }
        if (!str_starts_with($data, $prefix) || strlen($data) !== strlen($prefix) + $length) {
            throw new \InvalidArgumentException('Unexpected base58check prefix or length.');
        }
        return substr($data, strlen($prefix));
    }

    private static function checksum(string $data): string
    {
        return substr(hash('sha256', hash('sha256', $data, true), true), 0, 4);
    }
}
