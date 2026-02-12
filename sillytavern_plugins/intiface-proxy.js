const http = require('http');
const { createProxyServer } = require('http-proxy');

let proxy = null;
let server = null;

function startProxy(targetPort = 12345, proxyPort = 12346) {
    return new Promise((resolve, reject) => {
        if (server) {
            console.log('Intiface Proxy: Already running');
            resolve({ port: proxyPort });
            return;
        }

        try {
            proxy = createProxyServer({
                target: `ws://127.0.0.1:${targetPort}`,
                ws: true,
                changeOrigin: true
            });

            server = http.createServer((req, res) => {
                res.writeHead(200);
                res.end('Intiface WebSocket Proxy Running');
            });

            server.on('upgrade', (req, socket, head) => {
                console.log('Intiface Proxy: WebSocket upgrade request');
                proxy.ws(req, socket, head);
            });

            proxy.on('error', (err) => {
                console.error('Intiface Proxy Error:', err.message);
            });

            server.listen(proxyPort, '127.0.0.1', () => {
                console.log(`Intiface Proxy: Listening on port ${proxyPort} -> ${targetPort}`);
                resolve({ port: proxyPort });
            });

            server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${proxyPort} is already in use`));
                } else {
                    reject(err);
                }
            });

        } catch (err) {
            reject(err);
        }
    });
}

function stopProxy() {
    return new Promise((resolve) => {
        if (!server) {
            console.log('Intiface Proxy: Not running');
            resolve();
            return;
        }

        console.log('Intiface Proxy: Stopping...');
        
        if (proxy) {
            proxy.close();
            proxy = null;
        }

        server.close(() => {
            console.log('Intiface Proxy: Stopped');
            server = null;
            resolve();
        });
    });
}

function isRunning() {
    return server !== null;
}

// Export for use as module
module.exports = {
    startProxy,
    stopProxy,
    isRunning
};

// If run directly as script, start the proxy
if (require.main === module) {
    startProxy()
        .then(() => console.log('Proxy started'))
        .catch(err => {
            console.error('Failed to start proxy:', err);
            process.exit(1);
        });
}
