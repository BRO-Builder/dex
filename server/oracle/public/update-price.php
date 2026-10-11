<?php

/**
 * BRO price oracle endpoint. Call it on a schedule (e.g. every 5 minutes):
 *
 *   curl -fsS -X POST -H "Authorization: Bearer $ORACLE_HTTP_TOKEN" https://example.com/update-price.php
 *
 * Add `?dry_run=1` to compute the price and decision without sending.
 * Only this file belongs in the web root; keep ../src outside it.
 */

declare(strict_types=1);

use BroOracle\Config;
use BroOracle\Oracle;
use BroOracle\Signer;

foreach (['Base58', 'Forge', 'Signer', 'Http', 'Config', 'Oracle'] as $class) {
    require __DIR__ . "/../src/{$class}.php";
}

header('Content-Type: application/json');
header('Cache-Control: no-store');

function respond(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

function requestToken(): string
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+(\S+)$/i', $header, $match)) {
        return $match[1];
    }
    return (string) ($_SERVER['HTTP_X_ORACLE_TOKEN'] ?? $_GET['token'] ?? '');
}

if (!in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', ['GET', 'POST'], true)) {
    respond(405, ['status' => 'error', 'error' => 'Use GET or POST.']);
}

try {
    $config = new Config();
} catch (Throwable $error) {
    error_log('bro-oracle config: ' . $error->getMessage());
    respond(500, ['status' => 'error', 'error' => 'Oracle is not configured. See the server log.']);
}

if (!hash_equals($config->httpToken, requestToken())) {
    respond(401, ['status' => 'error', 'error' => 'Unauthorized.']);
}

try {
    $oracle = new Oracle($config, new Signer($config->secretKey));
    respond(200, $oracle->run(isset($_GET['dry_run']) && $_GET['dry_run'] !== '0'));
} catch (Throwable $error) {
    error_log('bro-oracle: ' . $error->getMessage());
    respond(502, ['status' => 'error', 'error' => $error->getMessage()]);
}
