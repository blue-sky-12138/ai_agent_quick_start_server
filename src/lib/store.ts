// 简单的内存存储实现 / Simple memory storage implementation
// 注意：这是一个示例实现，数据在服务器重启后会丢失
// Note: This is an example implementation, data will be lost after server restart

// 用 globalThis 保存单例，防止 Next.js 按需编译各路由时模块重置导致内存丢失
const g = globalThis as typeof globalThis & { __agentStore?: AgentStore };

export class AgentStore {
    private agentInstanceId: string = "";
    private userToAgentInstance = new Map<string, string>();
    private agentInstanceToImageDataURL = new Map<string, string>();
    /** 实例对应的回答语言（中文名，用于 prompt 末尾「始终用xx语言回答」） */
    private agentInstanceToLanguage = new Map<string, string>();

    private constructor() {}

    public static getInstance(): AgentStore {
        if (!g.__agentStore) {
            g.__agentStore = new AgentStore();
        }
        return g.__agentStore;
    }

    public setAgentInstanceId(agentInstanceId: string): void {
        this.agentInstanceId = agentInstanceId;
        console.log('Saved agent instance ID (Memory):', agentInstanceId);
    }

    public getAgentInstanceId(): string {
        console.log('Loaded agent instance ID (Memory):', this.agentInstanceId || 'null');
        return this.agentInstanceId;
    }

    public bindUserToAgentInstance(userId: string, agentInstanceId: string): void {
        this.userToAgentInstance.set(userId, agentInstanceId);
        console.log(`Bound user to instance (Memory): user=${userId}, instance=${agentInstanceId}`);
    }

    public getAgentInstanceIdByUserId(userId: string): string {
        const agentInstanceId = this.userToAgentInstance.get(userId) || "";
        console.log(`Loaded instance by user (Memory): user=${userId}, instance=${agentInstanceId || 'null'}`);
        return agentInstanceId;
    }

    public unbindUserByAgentInstanceId(agentInstanceId: string): void {
        for (const [userId, instanceId] of this.userToAgentInstance.entries()) {
            if (instanceId === agentInstanceId) {
                this.userToAgentInstance.delete(userId);
                console.log(`Unbound user by instance (Memory): user=${userId}, instance=${agentInstanceId}`);
                break;
            }
        }
    }

    public setLatestImageDataURL(agentInstanceId: string, imageDataURL: string): void {
        const key = String(agentInstanceId);
        this.agentInstanceToImageDataURL.set(key, imageDataURL);
        console.log(`Saved latest image (Memory): instance=${key}`);
    }

    public getLatestImageDataURL(agentInstanceId: string): string {
        const key = String(agentInstanceId);
        const imageDataURL = this.agentInstanceToImageDataURL.get(key) || "";
        console.log(`Loaded latest image (Memory): instance=${key}, hasImage=${!!imageDataURL}`);
        return imageDataURL;
    }

    /** 返回当前内存中有图片的 agent_instance_id 列表（用于排查） */
    public getImageInstanceIds(): string[] {
        return Array.from(this.agentInstanceToImageDataURL.keys());
    }

    public clearLatestImage(agentInstanceId: string): void {
        this.agentInstanceToImageDataURL.delete(String(agentInstanceId));
        console.log(`Cleared latest image (Memory): instance=${agentInstanceId}`);
    }

    public setLanguageForAgentInstance(agentInstanceId: string, languageName: string): void {
        this.agentInstanceToLanguage.set(String(agentInstanceId), languageName);
        console.log(`Saved language for instance (Memory): instance=${agentInstanceId}, language=${languageName}`);
    }

    public getLanguageForAgentInstance(agentInstanceId: string): string {
        return this.agentInstanceToLanguage.get(String(agentInstanceId)) || "";
    }

    public clearLanguageForAgentInstance(agentInstanceId: string): void {
        this.agentInstanceToLanguage.delete(String(agentInstanceId));
        console.log(`Cleared language for instance (Memory): instance=${agentInstanceId}`);
    }
}