-- 创建分类表
CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT
);

-- 创建链接表
CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    "categoryId" TEXT REFERENCES categories(id) ON DELETE CASCADE,
    icon TEXT,
    "iconSource" TEXT DEFAULT 'none'
);

-- 创建索引以提高查询性能
CREATE INDEX IF NOT EXISTS idx_links_category_id ON links("categoryId");