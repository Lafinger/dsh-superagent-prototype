// 容器内面板端口转发：把容器各网卡 <port> 上的连接转发到回环 127.0.0.1:<port>。
//
// 为什么不用 0.0.0.0：面板本身要绑 127.0.0.1:<port>（插件管理 API 要求 loopback），
// 监听 0.0.0.0:<port> 会与它冲突（EADDRINUSE）。所以这里枚举所有非回环 IPv4 地址，
// 逐个 <地址>:<port> 监听，既能覆盖多个 docker 网络，又不占用回环端口。
// 转发保留原始字节（含 Host / Origin / Cookie），因此 Host 白名单与鉴权照常生效。
import net from 'node:net'
import os from 'node:os'

const port = Number(process.env.SUPERAGENT_PORT || 3083)
if (!Number.isInteger(port)) process.exit(0)

const addresses = Object.values(os.networkInterfaces())
  .flat()
  .filter(entry => entry && entry.family === 'IPv4' && !entry.internal)
  .map(entry => entry.address)
const targets = [...new Set(addresses)]
const fallback = process.env.PANEL_HOST
if (!targets.length && fallback && fallback !== '127.0.0.1') targets.push(fallback)
if (!targets.length) process.exit(0)

const handler = client => {
  const upstream = net.connect(port, '127.0.0.1')
  const close = () => { client.destroy(); upstream.destroy() }
  client.on('error', close)
  upstream.on('error', close)
  client.on('close', close)
  upstream.on('close', close)
  client.pipe(upstream)
  upstream.pipe(client)
}

for (const address of targets) {
  const server = net.createServer(handler)
  server.on('error', error => console.error(`[panel-forward] ${address}:${port} ${error.message}`))
  server.listen(port, address, () => {
    console.error(`[panel-forward] listening ${address}:${port} -> 127.0.0.1:${port}`)
  })
}
