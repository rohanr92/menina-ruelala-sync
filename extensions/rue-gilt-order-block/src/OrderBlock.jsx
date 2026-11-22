// "Rue Gilt" card on the Shopify order page: FedEx label + packing slip downloads.
import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export default async () => {
  render(<OrderBlock />, document.body);
};

function OrderBlock() {
  const orderId = shopify.data.selected?.[0]?.id; // gid://shopify/Order/123
  const numericId = String(orderId || '').split('/').pop();
  const [state, setState] = useState({ loading: true });
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      // fetch() to the app's own URL is authenticated automatically by Shopify.
      const res = await fetch(`/api/gilt/shopify-order/${numericId}`);
      if (!res.ok) throw new Error(`App returned ${res.status}`);
      setState({ loading: false, ...(await res.json()) });
    } catch (e) {
      setState({ loading: false, error: e.message });
    }
  }

  useEffect(() => { load(); }, [numericId]);

  async function createLabel() {
    setCreating(true);
    try {
      const res = await fetch(`/api/gilt/orders/${encodeURIComponent(state.orderNo)}/label`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setState((s) => ({ ...s, labelError: json.error || `Error ${res.status}` }));
    } finally {
      setCreating(false);
      load();
    }
  }

  if (state.loading) {
    return (
      <s-admin-block heading="Rue Gilt">
        <s-spinner accessibilityLabel="Loading" />
      </s-admin-block>
    );
  }
  if (state.error) {
    return (
      <s-admin-block heading="Rue Gilt">
        <s-text color="subdued">Couldn't reach the Rue La La Sync app ({state.error}).</s-text>
      </s-admin-block>
    );
  }
  if (!state.rueGilt) {
    return (
      <s-admin-block heading="Rue Gilt">
        <s-text color="subdued">Not a Rue Gilt order.</s-text>
      </s-admin-block>
    );
  }

  return (
    <s-admin-block heading={`Rue Gilt order ${state.orderNo}`}>
      <s-stack gap="base">
        {state.tracking ? (
          <s-text>FedEx tracking: <s-text type="strong">{state.tracking}</s-text></s-text>
        ) : (
          <s-text color="subdued">No FedEx label yet.</s-text>
        )}
        {state.labelError && !state.tracking && (
          <s-banner tone="critical" heading="Label problem">{state.labelError}</s-banner>
        )}
        <s-stack direction="inline" gap="base">
          {state.links.label && (
            <s-button href={state.links.label} target="_blank" variant="primary">Download label</s-button>
          )}
          <s-button href={state.links.slip} target="_blank">Packing slip</s-button>
          {state.links.label && (
            <s-button href={state.links.docs} target="_blank">Label + packing slip</s-button>
          )}
          {state.canCreateLabel && (
            <s-button variant="primary" loading={creating} onClick={createLabel}>Create FedEx label</s-button>
          )}
        </s-stack>
        {state.shipment && (
          <s-text color="subdued">
            Shipment file to Rue La La: {state.shipment.status === 'sent' ? 'sent' : 'waiting to send'}
          </s-text>
        )}
      </s-stack>
    </s-admin-block>
  );
}
