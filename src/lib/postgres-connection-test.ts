import { Pool, type PoolClient } from 'pg';

export class PostgresConnectionTest {
  private pool: Pool | null = null;

  constructor(connectionString: string) {
    if (!connectionString) {
      throw new Error("PostgreSQL连接字符串不能为空");
    }
    this.pool = new Pool({ connectionString });
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool?.connect();
      if (!client) {
        throw new Error("无法创建数据库连接");
      }
      
      // 测试数据库连接和基本查询
      const result = await client.query('SELECT NOW()');
      if (result.rows.length > 0) {
        return {
          success: true,
          message: "成功连接到PostgreSQL数据库"
        };
      } else {
        throw new Error("数据库查询未返回预期结果");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      return {
        success: false,
        message: `连接测试失败: ${errorMessage}`
      };
    } finally {
      await client?.release();
      await this.pool?.end();
    }
  }

  static async validateConnectionString(connectionString: string): Promise<{ success: boolean; message: string }> {
    const tester = new PostgresConnectionTest(connectionString);
    return tester.testConnection();
  }
}