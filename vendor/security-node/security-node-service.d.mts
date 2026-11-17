import type { Server } from 'node:http'
import type * as protocol from './node-security.js'

export interface SecurityNodeConfig {
  nodeId: string
  name: string
  privateKeyFile: string
  issuerKeys: Record<string, string>
  workspaces: { workspaceId: string; root: string; policyVersion: number }[]
  stateDir: string
  host: '127.0.0.1'
  port: number
  allowFileOnly: boolean
  /** 显式允许在 root 下运行（uid 归属校验失去隔离意义，仅保留路径范围防线）；默认拒绝。 */
  allowRoot?: boolean
  dshRef?: { kind: 'direct'; apiBaseUrl: string } | { kind: 'mapping'; mappingId: string }
}
export interface SecurityNode {
  server: Server
  readonly running: boolean
  close(): Promise<void>
  identity: { nodeId: string; keyId: string; publicKey: string; instanceId: string; isolation: protocol.NodeIsolation }
}
export function startSecurityNode(config: SecurityNodeConfig, implementation: typeof protocol): Promise<SecurityNode>
