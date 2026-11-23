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
    favicon: '/favicon.png',
    social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Robdel12/cricket' }],
    customCss: ['./src/styles/docs.css'],
    components: { Header: './src/components/Header.astro' },
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
