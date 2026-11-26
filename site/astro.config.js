import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

import { guideNavigation } from './navigation.js';
import { settings } from './scripts/settings.js';

let { base } = settings();

export default defineConfig({
  site: 'https://robdel12.github.io',
  base,
  trailingSlash: 'always',
  integrations: [starlight({
    title: 'Cricket',
    description: 'A small Node framework for APIs with explicit contracts.',
    favicon: '/favicon.svg',
    social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Robdel12/cricket' }],
    customCss: ['./src/styles/docs.css'],
    components: {
      Header: './src/components/Header.astro',
      SiteTitle: './src/components/SiteTitle.astro',
      Hero: './src/components/Hero.astro',
      MarkdownContent: './src/components/MarkdownContent.astro'
    },
    expressiveCode: {
      themes: ['github-dark-dimmed'],
      useStarlightUiThemeColors: false,
      styleOverrides: {
        borderRadius: '.75rem',
        borderColor: 'var(--cr-panel-edge)',
        codeBackground: 'var(--cr-panel)',
        codeFontFamily: 'var(--__sl-font-mono)',
        codeFontSize: '.875rem',
        codeLineHeight: '1.65',
        uiFontFamily: 'var(--__sl-font)',
        frames: {
          editorBackground: 'var(--cr-panel)',
          editorTabBarBackground: 'var(--cr-panel-raised)',
          editorActiveTabBackground: 'var(--cr-panel)',
          editorActiveTabIndicatorTopColor: 'var(--cr-amber)',
          editorTabBarBorderBottomColor: 'var(--cr-panel-edge)',
          terminalBackground: 'var(--cr-panel)',
          terminalTitlebarBackground: 'var(--cr-panel-raised)',
          terminalTitlebarBorderBottomColor: 'var(--cr-panel-edge)',
          terminalTitlebarDotsForeground: '#3a4a62',
          frameBoxShadowCssValue: 'none'
        }
      }
    },
    sidebar: [
      ...guideNavigation,
      { label: 'Reference', items: [
        { slug: 'cli' },
        { slug: 'api' },
        { label: 'Import paths', items: [{ autogenerate: { directory: 'api' } }], collapsed: true }
      ] },
      { label: 'Contribute', items: [{ slug: 'contributing/documentation' }, { slug: 'contributing/vision' }] }
    ]
  })]
});
