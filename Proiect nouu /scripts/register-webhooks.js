const required = [
  ['ORDERS_PAID', '/webhooks/shopify/order-paid']
];

const query = `#graphql
  query ExistingWebhookSubscriptions($first: Int!) {
    webhookSubscriptions(first: $first) {
      nodes {
        id
        topic
        uri
      }
    }
  }
`;

const mutation = `#graphql
  mutation CreateWebhookSubscription(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
        uri
      }
      userErrors {
        field
        message
      }
    }
  }
`;

for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_ACCESS_TOKEN', 'APP_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required.`);
}
const domain = process.env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
const apiVersion = process.env.SHOPIFY_API_VERSION || '2026-07';
const endpoint = `https://${domain}/admin/api/${apiVersion}/graphql.json`;

async function graphql(document, variables) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
    },
    body: JSON.stringify({ query: document, variables }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Shopify returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.data;
}

const existing = await graphql(query, { first: 100 });
for (const [topic, route] of required) {
  const uri = `${process.env.APP_URL.replace(/\/$/, '')}${route}`;
  const found = existing.webhookSubscriptions.nodes.some((item) => item.topic === topic && item.uri === uri);
  if (found) {
    console.info(`${topic} already registered: ${uri}`);
    continue;
  }
  const data = await graphql(mutation, { topic, webhookSubscription: { uri } });
  const payload = data.webhookSubscriptionCreate;
  if (payload.userErrors.length) {
    throw new Error(`${topic}: ${payload.userErrors.map((error) => error.message).join('; ')}`);
  }
  console.info(`${topic} registered: ${payload.webhookSubscription.uri}`);
}
