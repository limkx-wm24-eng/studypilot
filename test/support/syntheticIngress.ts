import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { loadIngressConfig } from '../../src/ingress.js';

// Explicit fixture-only proxy: a separate TCP connection from 127.0.0.2.
// The synthetic selector exists only on this loopback test server, is removed
// before forwarding, and is never interpreted by the application.
export const syntheticIngressConfig = () => loadIngressConfig({NODE_ENV:'production',INGRESS_MODE:'trusted-proxy',TRUSTED_PROXY_CIDRS:'127.0.0.2/32'});
export const closeServer = (server: Server) => new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
export async function startSyntheticIngress(app: Express) {
  const backend = app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>backend.once('listening',resolve));
  const port = (backend.address() as AddressInfo).port;
  const server = createServer((incoming,outgoing)=>{
    const headers = {...incoming.headers};
    const selector = headers['x-studypilot-test-client'];
    delete headers['x-studypilot-test-client'];
    headers['x-forwarded-for'] = typeof selector==='string'?selector:'192.0.2.1';
    const upstream = request({host:'127.0.0.1',port,localAddress:'127.0.0.2',path:incoming.url,method:incoming.method,headers},response=>{
      outgoing.writeHead(response.statusCode??502,response.headers);response.pipe(outgoing);
    });
    upstream.on('error',()=>{outgoing.writeHead(502);outgoing.end();});incoming.pipe(upstream);
  }).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  return {server,backend,base:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,async close(){await closeServer(server);await closeServer(backend);}};
}
