/** Await binding before publishing a listener or its address. */
export function listen(app, { port, host } = {}) {
  return new Promise((resolve, reject) => {
    let server = app.listen(port, host);
    let failed = error => {
      server.off('listening', listening);
      reject(error);
    };
    let listening = () => {
      server.off('error', failed);
      resolve(server);
    };
    server.once('error', failed);
    server.once('listening', listening);
  });
}

export function serverOrigin(server) {
  let { address, port, family } = server.address();
  let host = address;
  if (address === '::' || address === '0.0.0.0')
    host = 'localhost';
  else if (family === 'IPv6')
    host = `[${address}]`;

  return `http://${host}:${port}`;
}

/** Start closing now; callers may end accepted streams while this is pending. */
export function closeServer(server, { closeConnections = 'idle' } = {}) {
  let closing = new Promise((resolve, reject) => {
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING')
        reject(error);
      else
        resolve();
    });

    if (closeConnections === 'all')
      server.closeAllConnections();
    else if (closeConnections === 'idle')
      server.closeIdleConnections();
  });

  // The owner may be awaiting its shutdown hook before joining this promise.
  void closing.catch(() => {});
  return closing;
}
