import type { SiteLanguage } from '../types'
import aboutTheAtlasEn from './articles/about-the-atlas-en.md?raw'
import aboutTheAtlasZh from './articles/about-the-atlas-zh.md?raw'
import dataAndMethodologyEn from './articles/data-and-methodology-en.md?raw'
import dataAndMethodologyZh from './articles/data-and-methodology-zh.md?raw'
import exploreFurtherEn from './articles/explore-further-en.md?raw'
import exploreFurtherZh from './articles/explore-further-zh.md?raw'

export type ArticleSlug = 'about-the-atlas' | 'data-and-methodology' | 'explore-further'

export type LocalizedArticle = {
  title: string
  eyebrow: string
  source: string
  editPath: string
}

export type SiteArticle = {
  slug: ArticleSlug
  translations: Record<SiteLanguage, LocalizedArticle>
}

export const SITE_ARTICLES: SiteArticle[] = [
  {
    slug: 'about-the-atlas',
    translations: {
      en: {
        title: 'About the Atlas',
        eyebrow: 'Orientation',
        source: aboutTheAtlasEn,
        editPath: 'src/content/articles/about-the-atlas-en.md',
      },
      zh: {
        title: '关于本站',
        eyebrow: '导览',
        source: aboutTheAtlasZh,
        editPath: 'src/content/articles/about-the-atlas-zh.md',
      },
    },
  },
  {
    slug: 'data-and-methodology',
    translations: {
      en: {
        title: 'Data & Methodology',
        eyebrow: 'Provenance',
        source: dataAndMethodologyEn,
        editPath: 'src/content/articles/data-and-methodology-en.md',
      },
      zh: {
        title: '数据与方法',
        eyebrow: '数据来源',
        source: dataAndMethodologyZh,
        editPath: 'src/content/articles/data-and-methodology-zh.md',
      },
    },
  },
  {
    slug: 'explore-further',
    translations: {
      en: {
        title: 'Explore Further',
        eyebrow: 'Reading room',
        source: exploreFurtherEn,
        editPath: 'src/content/articles/explore-further-en.md',
      },
      zh: {
        title: '延伸探索',
        eyebrow: '阅览室',
        source: exploreFurtherZh,
        editPath: 'src/content/articles/explore-further-zh.md',
      },
    },
  },
]

export const SITE_ARTICLES_BY_SLUG = Object.fromEntries(
  SITE_ARTICLES.map((article) => [article.slug, article]),
) as Record<ArticleSlug, SiteArticle>

export function isArticleSlug(value: string): value is ArticleSlug {
  return value in SITE_ARTICLES_BY_SLUG
}
