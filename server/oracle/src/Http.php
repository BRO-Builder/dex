<?php

declare(strict_types=1);

namespace BroOracle;

/** Minimal JSON-over-HTTP client using curl. */
final class Http
{
    public static function get(string $url): mixed
    {
        return self::request('GET', $url);
    }

    public static function post(string $url, mixed $body): mixed
    {
        return self::request('POST', $url, $body);
    }

    private static function request(string $method, string $url, mixed $body = null): mixed
    {
        $curl = curl_init($url);
        $headers = ['Accept: application/json'];
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_USERAGENT => 'bro-oracle/1.0',
        ]);
        if ($method === 'POST') {
            $headers[] = 'Content-Type: application/json';
            curl_setopt($curl, CURLOPT_POST, true);
            curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
        }
        curl_setopt($curl, CURLOPT_HTTPHEADER, $headers);
        $response = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $error = curl_error($curl);
        curl_close($curl);

        $host = parse_url($url, PHP_URL_HOST);
        if ($response === false) {
            throw new \RuntimeException("Request to {$host} failed: {$error}");
        }
        if ($status < 200 || $status >= 300) {
            throw new \RuntimeException("Request to {$host} failed (HTTP {$status}): " . substr((string) $response, 0, 500));
        }
        return json_decode((string) $response, true, 512, JSON_THROW_ON_ERROR);
    }
}
