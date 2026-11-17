/**
 * 站点所有者当前在用的 Shadowrocket 配置原文（2026-11-17 快照）。
 *
 * IOS_MIGRATED 预设 = 这份原文过一遍 parseShadowrocketConf 的输出。
 * 不手写翻译 —— 手写的"近似"会悄悄偏离真实意图（第一版就犯过：
 * 把精确节点名单写成了宽松正则，导致分组混入大量无关节点）。
 */
export const OWNER_SHADOWROCKET_CONF = `
# Shadowrocket: 2026-11-17 07:54:01
[General]
#dns-server = https://8.8.8.8/dns-query

#dns-server = https://dns.google/dns-query
##PROXY,https://8.8.8.8/dns-query#PROXY,https://cloudflare-dns.com/dns-query#PROXY
# dns-server = https://doh.pub/dns-query

dns-server = https://cloudflare-dns.com/dns-query#proxy,https://dns.google/dns-query#proxy

# 直连域名：用手机当前网络的国内 DNS（运营商 / 系统）
dns-direct-system = true
fallback-dns-server = https://1.1.1.1/dns-query#proxy
bypass-system = true
skip-proxy = 192.168.0.0/16, 100.64.0.0/10, 10.0.0.0/8, 172.16.0.0/12, localhost,*.20260401.xyz,*.ai.gsbot.dev, git.gs-robot.com,*.local, *.mysql.rds.aliyuncs.com, jira.gs-robot.com, bot.ma.intra.gs-robot.com, artemis.ma.intra.gs-robot.com, 172.19.0.0/12 ,e.]
tun-excluded-routes = 10.0.0.0/8,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.0.0.0/24,192.0.2.0/24,192.88.99.0/24,192.168.0.0/16,198.18.0.0/15,198.51.100.0/24,203.0.113.0/24,224.0.0.0/4,255.255.255.255/32,138.75.58.11/32,10.12.0.0/16, 172.19.0.0/12
ipv6 = false
prefer-ipv6 = false
dns-fallback-system = false
icmp-auto-reply = true
always-real-ip = *.20260401.xyz,*.ai.gsbot.dev,git.gs-robot.com
always-reject-url-rewrite = false
private-ip-answer = true
dns-direct-fallback-proxy = false
update-url = https://raw.githubusercontent.com/cfrs2005/mantaray/main/configs/strict.conf

[Proxy Group]
GOOGLE = fallback,DMIT-VIA-US-LOS-CG,DMIT-SS2022,policy-select-name=DMIT-VIA-US-LOS-CG,interval=600,timeout=5,url=http://www.gstatic.com/generate_204
AI-CLAUDE = url-test,VERIZON-VIA-BWG,VERIZON-VIA-TXSH,VERIZON-VIA-DMIT,policy-select-name=VERIZON-VIA-BWG,interval=600,tolerance=100,timeout=5,url=http://www.gstatic.com/generate_204
AI-OPENAI = url-test,GANBEI-VIA-TXSH,GANBEI-VIA-DMIT,policy-select-name=GANBEI-VIA-TXSH,interval=600,tolerance=100,timeout=5,url=http://www.gstatic.com/generate_204

[Rule]
DOMAIN-SUFFIX,drleao.cn,DMIT-VIA-US-LOS-CG
DOMAIN-SUFFIX,wirqed.cn,PROXY
DOMAIN-SUFFIX,pic.wirqed.cn,PROXY
DOMAIN-SUFFIX,chatgpt.site,AI-OPENAI
IP-CIDR,10.12.50.0/24,DIRECT,no-resolve

#DOMAIN-SUFFIX,anthropic.com,DIRECT
#DOMAIN-SUFFIX,claude.ai,DIRECT
#DOMAIN-SUFFIX,claude.com,DIRECT
#DOMAIN-SUFFIX,clau.de,DIRECT
#DOMAIN-SUFFIX,claudemcpclient.com,DIRECT
#DOMAIN-SUFFIX,claudemcpcontent.com,DIRECT
#DOMAIN-SUFFIX,claudeusercontent.com,DIRECT
DOMAIN-SUFFIX,link.fufeishangban.com,DIRECT
DOMAIN-SUFFIX,browser-intake-datadoghq.com,PROXY,extended-matching
DOMAIN-SUFFIX,bot-eu.gs-robot.com,PROXY
DOMAIN-SUFFIX,seagm.com,DIRECT
DOMAIN-SUFFIX,gs-robot.com,DIRECT
DOMAIN-SUFFIX,gs-robot.com,DIRECT
#DOMAIN-SUFFIX,linux.do,上海电信转香港HKT[M][TROJAN][倍率:1]

RULE-SET,https://raw.githubusercontent.com/cfrs2005/mantaray/refs/heads/main/rules/openai.list,AI-OPENAI
RULE-SET,https://cdn.jsdelivr.net/gh/VPSDance/ai-proxy-rules@main/rules/shadowrocket/anthropic.list,AI-OPENAI
RULE-SET,https://raw.githubusercontent.com/cfrs2005/mantaray/refs/heads/main/rules/googleai.lsit,AI-CLAUDE

# 高风控服务 - 固定代理（核心）
RULE-SET,https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/sensitive_services.list,GOOGLE
RULE-SET,https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/crypto.list,GOOGLE

# 局域网直连

# 国内域名优先
DOMAIN-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/ChinaMaxNoIP/ChinaMaxNoIP_Domain.list,DIRECT
RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/ChinaMaxNoIP/ChinaMaxNoIP.list,DIRECT
RULE-SET,https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/lan_direct.list,DIRECT
RULE-SET,https://github.com/cfrs2005/mantaray/blob/main/rules/dingTalk.list,DIRECT

# 中国域名直连
RULE-SET,https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/direct_cn.list,DIRECT

# GeoIP 兜底
GEOIP,CN,DIRECT

# 非中国流量一律代理

#FINAL,BWG-AUTO
FINAL,PROXY

[Host]
cloudflare-dns.com = 1.1.1.1
dns.google = 8.8.8.8
dns.alidns.com = 223.5.5.5
doh.pub = 1.12.12.12

# fallback: use plain UDP DNS (223.5.5.5 = AliDNS)
*.feishu.cn = server:https://doh.pub/dns-query
*.aiforce.run = server:https://doh.pub/dns-query
*.zijieapi.com = server:https://doh.pub/dns-query
*.feishucdn.com = server:https://doh.pub/dns-query
*.gs-robot.com = server:https://doh.pub/dns-query
*.gsbot.net = server:https://doh.pub/dns-query
*.gsbot.cc = server:https://doh.pub/dns-query
*.80aj.com = server:https://doh.pub/dns-query
*.426624.xyz = server:https://doh.pub/dns-query
*.tccoany.com = server:https://doh.pub/dns-query
*.629630.xyz = server:https://doh.pub/dns-query
*.164165.xyz = server:https://doh.pub/dns-query
*.731732.xyz = server:https://doh.pub/dns-query
*.122733.xyz = server:https://doh.pub/dns-query
*.9a2kq8m5.top = server:https://doh.pub/dns-query
`;
