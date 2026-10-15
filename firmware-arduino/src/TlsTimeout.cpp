// Caps the TLS handshake (P2-25). WiFiClientSecure starts every connection
// with a 120s handshake timeout, and the websocket library creates a new
// client and connects in one step, so there is no moment to call
// setHandshakeTimeout() on it. On a phone hotspot that stalls mid-handshake,
// every reconnect then took ~121s (2026-10-13).
//
// The linker sends the core's calls to start_ssl_client() here instead
// (-Wl,--wrap in platformio.ini, which also defines TLS_HANDSHAKE_TIMEOUT_MS);
// this lowers the timeout and calls the original. It covers the websocket, the
// token request and the OTA download alike. The symbol is the Arduino 2.0.17
// core's C++ name for start_ssl_client(): a core upgrade that changes the
// signature fails the link rather than silently dropping the cap.

#ifdef TLS_HANDSHAKE_TIMEOUT_MS

#include <WiFiClientSecure.h>

#define START_SSL_CLIENT "_Z16start_ssl_clientP17sslclient_contextRK9IPAddressmPKciS5_bS5_S5_S5_S5_bPS5_"

int realStartSslClient(sslclient_context *ssl_client, const IPAddress &ip, unsigned long port,
                       const char *hostname, int timeout, const char *rootCABuff, bool useRootCABundle,
                       const char *cli_cert, const char *cli_key, const char *pskIdent,
                       const char *psKey, bool insecure, const char **alpn_protos)
    __asm__("__real_" START_SSL_CLIENT);

int cappedStartSslClient(sslclient_context *ssl_client, const IPAddress &ip, unsigned long port,
                         const char *hostname, int timeout, const char *rootCABuff, bool useRootCABundle,
                         const char *cli_cert, const char *cli_key, const char *pskIdent,
                         const char *psKey, bool insecure, const char **alpn_protos)
    __asm__("__wrap_" START_SSL_CLIENT);

int cappedStartSslClient(sslclient_context *ssl_client, const IPAddress &ip, unsigned long port,
                         const char *hostname, int timeout, const char *rootCABuff, bool useRootCABundle,
                         const char *cli_cert, const char *cli_key, const char *pskIdent,
                         const char *psKey, bool insecure, const char **alpn_protos) {
    if (ssl_client->handshake_timeout > TLS_HANDSHAKE_TIMEOUT_MS) {
        ssl_client->handshake_timeout = TLS_HANDSHAKE_TIMEOUT_MS;
    }
    return realStartSslClient(ssl_client, ip, port, hostname, timeout, rootCABuff, useRootCABundle,
                              cli_cert, cli_key, pskIdent, psKey, insecure, alpn_protos);
}

#endif
