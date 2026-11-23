function guides(label, items) {
  return { label, items: items.map(slug => ({ slug: `guides/${slug}` })) };
}

export let guideNavigation = [
  { label: 'Start here', items: [{ label: 'Cricket', slug: '' }, { slug: 'guides/getting-started' }] },
  guides('Build an API', ['domains', 'contracts', 'http', 'database', 'plugins', 'openapi']),
  guides('Run your app', ['machines', 'jobs', 'observability', 'testing'])
];

export let guideOrder = guideNavigation.flatMap(group => group.items)
  .map(item => item.slug)
  .filter(slug => slug.startsWith('guides/'))
  .map(slug => slug.slice('guides/'.length));
