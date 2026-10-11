<?php

declare(strict_types=1);

namespace BroOracle;

/**
 * ed25519 (tz1) signing with the bundled sodium extension.
 */
final class Signer
{
    private string $secretKey;
    private string $publicKey;

    /** Accepts an unencrypted `edsk...` key: the 32-byte seed form or the 64-byte form. */
    public function __construct(string $edsk)
    {
        $edsk = trim($edsk);
        if (strlen($edsk) === 54) {
            $seed = Base58::checkDecode($edsk, Base58::EDSK_SEED, 32);
            $pair = sodium_crypto_sign_seed_keypair($seed);
            $this->secretKey = sodium_crypto_sign_secretkey($pair);
            $this->publicKey = sodium_crypto_sign_publickey($pair);
        } elseif (strlen($edsk) === 98) {
            $this->secretKey = Base58::checkDecode($edsk, Base58::EDSK_SECRET, 64);
            $this->publicKey = sodium_crypto_sign_publickey_from_secretkey($this->secretKey);
        } else {
            throw new \InvalidArgumentException('ORACLE_SECRET_KEY must be an unencrypted ed25519 edsk... key.');
        }
    }

    public function address(): string
    {
        return Base58::checkEncode(Base58::TZ1, sodium_crypto_generichash($this->publicKey, '', 20));
    }

    public function publicKey(): string
    {
        return Base58::checkEncode(Base58::EDPK, $this->publicKey);
    }

    /** Signature over the generic-operation watermark (0x03) + bytes. */
    public function sign(string $operationBytes): string
    {
        $digest = sodium_crypto_generichash("\x03" . $operationBytes, '', 32);
        return sodium_crypto_sign_detached($digest, $this->secretKey);
    }

    public static function operationHash(string $signedBytes): string
    {
        return Base58::checkEncode(Base58::OPERATION, sodium_crypto_generichash($signedBytes, '', 32));
    }
}
