import aboutTheAtlas from './articles/about-the-atlas.md?raw'
import dataAndMethodology from './articles/data-and-methodology.md?raw'
import exploreFurther from './articles/explore-further.md?raw'

export type ArticleSlug = 'about-the-atlas' | 'data-and-methodology' | 'explore-further'

export type SiteArticle = {
  slug: ArticleSlug
  title: string
  eyebrow: string
  source: string
  editPath: string
}

export const SITE_ARTICLES: SiteArticle[] = [
  {
    slug: 'about-the-atlas',
    title: 'About the Atlas',
    eyebrow: 'Orientation',
    source: aboutTheAtlas,
    editPath: 'src/content/articles/about-the-atlas.md',
  },
  {
    slug: 'data-and-methodology',
    title: 'Data & Methodology',
    eyebrow: 'Provenance',
    source: dataAndMethodology,
    editPath: 'src/content/articles/data-and-methodology.md',
  },
  {
    slug: 'explore-further',
    title: 'Explore Further',
    eyebrow: 'Reading room',
    source: exploreFurther,
    editPath: 'src/content/articles/explore-further.md',
  },
]

export const SITE_ARTICLES_BY_SLUG = Object.fromEntries(
  SITE_ARTICLES.map((article) => [article.slug, article]),
) as Record<ArticleSlug, SiteArticle>

export function isArticleSlug(value: string): value is ArticleSlug {
  return value in SITE_ARTICLES_BY_SLUG
}
