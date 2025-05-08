import type { Category, LinkItem } from '@/types';
import type { IDataService } from './data-service-interface';
import { Pool, type PoolClient } from 'pg';
import crypto from 'crypto';

// Database table names
const CATEGORIES_TABLE = 'categories';
const LINKS_TABLE = 'links';

export class PostgresDataService implements IDataService {
  private pool: Pool | null = null;
  private readonly maxRetries = 3;
  private readonly retryDelay = 1000; // 毫秒

  constructor() {
    try {
      const connectionString = process.env.POSTGRES_CONNECTION_STRING;
      const poolConfig = {
        max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS || '20', 10), // 最大连接数
        idleTimeoutMillis: parseInt(process.env.POSTGRES_IDLE_TIMEOUT || '30000', 10), // 空闲连接超时
        connectionTimeoutMillis: parseInt(process.env.POSTGRES_CONNECTION_TIMEOUT || '5000', 10), // 连接超时
      };

      if (connectionString) {
        this.pool = new Pool({ 
          connectionString,
          ...poolConfig
        });
        console.log("PostgresDataService: Pool configured using POSTGRES_CONNECTION_STRING.");
      } else if (
        process.env.POSTGRES_HOST &&
        process.env.POSTGRES_PORT &&
        process.env.POSTGRES_USER &&
        process.env.POSTGRES_PASSWORD &&
        process.env.POSTGRES_DB
      ) {
        this.pool = new Pool({
          host: process.env.POSTGRES_HOST,
          port: parseInt(process.env.POSTGRES_PORT, 10),
          user: process.env.POSTGRES_USER,
          password: process.env.POSTGRES_PASSWORD,
          database: process.env.POSTGRES_DB,
          ...poolConfig
        });
        console.log("PostgresDataService: Pool configured using individual POSTGRES_ variables.");
      } else {
        throw new Error("PostgreSQL connection details not found in environment variables. Set POSTGRES_CONNECTION_STRING or individual POSTGRES_ variables.");
      }

      // 监听连接池事件
      this.pool.on('error', (err) => {
        console.error('PostgresDataService: Unexpected error on idle client', err);
      });

      this.testConnection();
    } catch (error) {
      console.error("PostgresDataService: Failed to initialize PostgreSQL pool during constructor:", error);
      this.pool = null; 
      throw error; 
    }
  }

  private async testConnection() {
    if (!this.pool) {
        console.warn("PostgresDataService: Pool is not initialized, skipping connection test.");
        return { success: false, message: "数据库连接池未初始化" };
    }
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const result = await client.query('SELECT NOW()');
      if (result.rows.length > 0) {
        console.log("PostgresDataService: Successfully connected to PostgreSQL via pool and tested.");
        return { success: true, message: "成功连接到PostgreSQL数据库" };
      }
      throw new Error("数据库查询未返回预期结果");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error("PostgresDataService: Failed to connect to PostgreSQL via pool during testConnection:", error);
      return { success: false, message: `连接测试失败: ${errorMessage}` };
    } finally {
      client?.release();
    }
  }

  private async executeQuery<T>(queryText: string, values?: any[]): Promise<T[]> {
    if (!this.pool) {
      console.error("PostgresDataService: PostgreSQL pool not initialized. Cannot execute query.");
      throw new Error("PostgreSQL pool not initialized.");
    }

    let attempts = 0;
    while (attempts < this.maxRetries) {
      let client: PoolClient | undefined;
      try {
        client = await this.pool.connect();
        const result = await client.query(queryText, values);
        return result.rows as T[];
      } catch (error) {
        attempts++;
        const isRetryable = this.isRetryableError(error);
        console.error(
          `PostgresDataService: Error executing query "${queryText.substring(0,100)}..." (Attempt ${attempts}/${this.maxRetries}):`,
          error
        );

        if (!isRetryable || attempts >= this.maxRetries) {
          throw error;
        }

        console.log(`PostgresDataService: Retrying query in ${this.retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
      } finally {
        client?.release();
      }
    }
    throw new Error(`Query failed after ${this.maxRetries} attempts`);
  }

  private isRetryableError(error: any): boolean {
    // 定义可重试的错误类型
    const retryableErrors = [
      'connection timeout',
      'connection reset',
      'Connection terminated',
      'too many clients',
      'deadlock detected'
    ];

    const errorMessage = error?.message?.toLowerCase() || '';
    return retryableErrors.some(retryableError => 
      errorMessage.includes(retryableError.toLowerCase())
    );
  }


  async getCategories(): Promise<Category[]> {
    // Assumes table 'categories' with columns: id (TEXT), name (TEXT), description (TEXT), icon (TEXT)
    const query = `SELECT id, name, description, icon FROM ${CATEGORIES_TABLE}`;
    return this.executeQuery<Category>(query);
  }

  async getCategory(id: string): Promise<Category | undefined> {
    const query = `SELECT id, name, description, icon FROM ${CATEGORIES_TABLE} WHERE id = $1`;
    const categories = await this.executeQuery<Category>(query, [id]);
    return categories[0];
  }

  async addCategory(categoryData: Omit<Category, 'id'>): Promise<Category> {
    const { name, description, icon } = categoryData;
    const newId = crypto.randomUUID();
    const query = `INSERT INTO ${CATEGORIES_TABLE} (id, name, description, icon) VALUES ($1, $2, $3, $4) RETURNING id, name, description, icon`;
    const result = await this.executeQuery<Category>(query, [newId, name, description || null, icon || null]);
    if (result.length === 0) {
        throw new Error("PostgresDataService: Failed to add category, no data returned.");
    }
    return result[0];
  }

  async updateCategory(updatedCategory: Category): Promise<Category | null> {
    const { id, name, description, icon } = updatedCategory;
    const query = `UPDATE ${CATEGORIES_TABLE} SET name = $1, description = $2, icon = $3 WHERE id = $4 RETURNING id, name, description, icon`;
    const result = await this.executeQuery<Category>(query, [name, description || null, icon || null, id]);
    return result[0] || null;
  }

  async deleteCategory(id: string): Promise<boolean> {
    if (!this.pool) {
      console.error("PostgresDataService: PostgreSQL pool not initialized. Cannot delete category.");
      return false;
    }
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Use "categoryId" to match the LinkItem type property.
      await client.query(`DELETE FROM ${LINKS_TABLE} WHERE "categoryId" = $1`, [id]);
      const result = await client.query(`DELETE FROM ${CATEGORIES_TABLE} WHERE id = $1`, [id]);
      await client.query('COMMIT');
      return result.rowCount !== null && result.rowCount > 0;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('PostgresDataService: Error deleting category or its links from Postgres:', error);
      return false;
    } finally {
      client.release();
    }
  }

  async getLinks(): Promise<LinkItem[]> {
    // Assumes table 'links' with columns: id (TEXT), title (TEXT), url (TEXT), description (TEXT), 
    // "categoryId" (TEXT), icon (TEXT), "iconSource" (TEXT)
    const query = `SELECT id, title, url, description, "categoryId", icon, "iconSource" FROM ${LINKS_TABLE}`;
    return this.executeQuery<LinkItem>(query);
  }

  async getLinksByCategoryId(categoryId: string): Promise<LinkItem[]> {
    const query = `SELECT id, title, url, description, "categoryId", icon, "iconSource" FROM ${LINKS_TABLE} WHERE "categoryId" = $1`;
    return this.executeQuery<LinkItem>(query, [categoryId]);
  }

  async getLink(id: string): Promise<LinkItem | undefined> {
    const query = `SELECT id, title, url, description, "categoryId", icon, "iconSource" FROM ${LINKS_TABLE} WHERE id = $1`;
    const links = await this.executeQuery<LinkItem>(query, [id]);
    return links[0];
  }

  async addLink(linkData: Omit<LinkItem, 'id'>): Promise<LinkItem> {
    const { title, url, description, categoryId, icon, iconSource } = linkData;
    const newId = crypto.randomUUID();
    const query = `INSERT INTO ${LINKS_TABLE} (id, title, url, description, "categoryId", icon, "iconSource") VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, title, url, description, "categoryId", icon, "iconSource"`;
    const result = await this.executeQuery<LinkItem>(query, [newId, title, url, description || null, categoryId, icon || null, iconSource || 'none']);
    if (result.length === 0) {
        throw new Error("PostgresDataService: Failed to add link, no data returned.");
    }
    return result[0];
  }

  async updateLink(updatedLink: LinkItem): Promise<LinkItem | null> {
    const { id, title, url, description, categoryId, icon, iconSource } = updatedLink;
    const query = `UPDATE ${LINKS_TABLE} SET title = $1, url = $2, description = $3, "categoryId" = $4, icon = $5, "iconSource" = $6 WHERE id = $7 RETURNING id, title, url, description, "categoryId", icon, "iconSource"`;
    const result = await this.executeQuery<LinkItem>(query, [title, url, description || null, categoryId, icon || null, iconSource || 'none', id]);
    return result[0] || null;
  }

  async deleteLink(id: string): Promise<boolean> {
    const query = `DELETE FROM ${LINKS_TABLE} WHERE id = $1`;
    if (!this.pool) {
        console.error("PostgresDataService: PostgreSQL pool not initialized. Cannot delete link.");
        return false;
    }
    let client: PoolClient | undefined;
    try {
        client = await this.pool.connect();
        const result = await client.query(query, [id]);
        return result.rowCount !== null && result.rowCount > 0;
    } catch (error) {
        console.error(`PostgresDataService: Error executing query "DELETE FROM ${LINKS_TABLE} WHERE id = $1":`, error);
        return false;
    } finally {
        client?.release();
    }
  }
}
