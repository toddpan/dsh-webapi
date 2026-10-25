/**
 * dsh-web-service - 机器网络指纹
 *
 * 供 GET /ping 返回 DSH 所在机器的本地 IP 与 MAC，调用方据此判定
 * 127.0.0.1（natpass 等隧道转发）节点是否本机：MAC 命中本机网卡即为本地 DSH，
 * 否则是隧道映射进来的远端 DSH。MAC 是比对首选——IP 在 NAT/多网卡下不稳定。
 */
export interface MachineAddress {
    address: string;
    family: string;
    internal: boolean;
}
export interface MachineInterface {
    name: string;
    mac: string;
    addresses: MachineAddress[];
}
export interface MachineIdentity {
    hostname: string;
    platform: string;
    arch: string;
    /** 非回环 IP 平铺列表（比对用） */
    ips: string[];
    /** 非回环网卡 MAC 去重小写列表（比对首选，主机级稳定标识） */
    macs: string[];
    /** 全部网卡明细（含回环，排查用） */
    interfaces: MachineInterface[];
}
export declare function collectMachineIdentity(): MachineIdentity;
