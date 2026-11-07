// source.config.ts
import { defineDocs, defineCollections, defineConfig, frontmatterSchema } from "fumadocs-mdx/config";
import { z } from "zod";
var docs = defineDocs({
  dir: "content/docs"
});
var blogPosts = defineCollections({
  type: "doc",
  dir: "content/blog",
  schema: frontmatterSchema.extend({
    author: z.string(),
    date: z.string().date().or(z.date())
  })
});
var source_config_default = defineConfig();
export {
  blogPosts,
  source_config_default as default,
  docs
};
