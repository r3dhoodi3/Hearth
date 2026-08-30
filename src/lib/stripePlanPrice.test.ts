import { describe, it, expect, beforeEach, vi } from "vitest";
import { PLUS_PLAN, extraHomeUnitPrice } from "./constants";

// The module reaches Stripe through @/lib/stripe, which imports "server-only"
// and throws without a secret key. Both are stubbed so the real find-or-create
// logic can be driven.
vi.mock("server-only", () => ({}));

const productsList = vi.fn();
const productsCreate = vi.fn();
const pricesList = vi.fn();
const pricesCreate = vi.fn();

vi.mock("@/lib/stripe", () => ({
  stripe: {
    products: {
      list: (...a: unknown[]) => productsList(...a),
      create: (...a: unknown[]) => productsCreate(...a),
    },
    prices: {
      list: (...a: unknown[]) => pricesList(...a),
      create: (...a: unknown[]) => pricesCreate(...a),
    },
  },
}));

const { plusPriceId, homeSlotPriceId, __resetPlanPriceCacheForTests } =
  await import("./stripePlanPrice");

type FakeProduct = {
  id: string;
  active: boolean;
  metadata?: Record<string, string>;
};
type FakePrice = {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number;
  recurring?: { interval: string; interval_count?: number };
};

function setProducts(pages: FakeProduct[][]) {
  let call = 0;
  productsList.mockImplementation(async () => {
    const data = pages[call] ?? [];
    const has_more = call < pages.length - 1;
    call++;
    return { data, has_more };
  });
}

function setPrices(data: FakePrice[]) {
  pricesList.mockImplementation(async () => ({ data, has_more: false }));
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPlanPriceCacheForTests();
  delete process.env.STRIPE_PRICE_PLUS_WEEKLY;
  delete process.env.STRIPE_PRICE_PLUS_MONTHLY;
  delete process.env.STRIPE_PRICE_PLUS_YEARLY;
  delete process.env.STRIPE_PRICE_HOME_SLOT_MONTHLY;
  delete process.env.STRIPE_PRICE_HOME_SLOT_YEARLY;
  setProducts([[]]);
  setPrices([]);
  productsCreate.mockResolvedValue({ id: "prod_new" });
  pricesCreate.mockResolvedValue({ id: "price_new" });
});

describe("a configured Price always wins", () => {
  it("returns the env price and never touches the Stripe catalog", async () => {
    process.env.STRIPE_PRICE_PLUS_YEARLY = "price_env_yearly";
    expect(await plusPriceId("yearly")).toBe("price_env_yearly");
    expect(productsList).not.toHaveBeenCalled();
    expect(productsCreate).not.toHaveBeenCalled();
    expect(pricesCreate).not.toHaveBeenCalled();
  });

  it("does the same for the extra-home add-on", async () => {
    process.env.STRIPE_PRICE_HOME_SLOT_MONTHLY = "price_env_slot";
    expect(await homeSlotPriceId("monthly", 2)).toBe("price_env_slot");
    expect(productsCreate).not.toHaveBeenCalled();
  });
});

describe("the fallback never references an inactive product", () => {
  // THE LIVE BUG: the "Hearth Plus" product on the connected account was
  // archived, the switch-to-yearly action pointed inline price_data at it, and
  // Stripe refused ("marked as inactive, and thus no new subscriptions can be
  // created to any plans of this product"). An archived product must read as
  // "not found" and a fresh active one must be created.
  it("ignores an archived tagged product and creates an active one", async () => {
    setProducts([
      [
        { id: "prod_archived", active: false, metadata: { hearth_plan: "plus" } },
        { id: "prod_other", active: true, metadata: { hearth_plan: "pro" } },
      ],
    ]);

    const id = await plusPriceId("yearly");

    expect(productsCreate).toHaveBeenCalledWith({
      name: "Hearth Plus",
      metadata: { hearth_plan: "plus" },
    });
    expect(id).toBe("price_new");
    // The price hangs off the product we just proved is active, never off the
    // one read from the subscription.
    expect(pricesCreate.mock.calls[0][0]).toMatchObject({ product: "prod_new" });
  });

  it("only ever asks Stripe for active products", async () => {
    await plusPriceId("monthly");
    expect(productsList.mock.calls[0][0]).toMatchObject({ active: true });
  });
});

describe("prices are found before they are created", () => {
  it("reuses an active price at the same amount and interval", async () => {
    setProducts([[{ id: "prod_plus", active: true, metadata: { hearth_plan: "plus" } }]]);
    setPrices([
      // Right product, wrong interval: not a match.
      {
        id: "price_month",
        active: true,
        currency: "usd",
        unit_amount: Math.round(PLUS_PLAN.yearly * 100),
        recurring: { interval: "month" },
      },
      {
        id: "price_year",
        active: true,
        currency: "usd",
        unit_amount: Math.round(PLUS_PLAN.yearly * 100),
        recurring: { interval: "year", interval_count: 1 },
      },
    ]);

    expect(await plusPriceId("yearly")).toBe("price_year");
    expect(productsCreate).not.toHaveBeenCalled();
    expect(pricesCreate).not.toHaveBeenCalled();
  });

  it("creates the price at the amount PLUS_PLAN says, per cadence", async () => {
    setProducts([[{ id: "prod_plus", active: true, metadata: { hearth_plan: "plus" } }]]);
    await plusPriceId("weekly");
    expect(pricesCreate.mock.calls[0][0]).toMatchObject({
      currency: "usd",
      unit_amount: Math.round(PLUS_PLAN.weekly * 100),
      recurring: { interval: "week" },
      product: "prod_plus",
    });
  });

  it("reuses what it created on the next call in the same process", async () => {
    setProducts([[]]);
    await plusPriceId("monthly");
    await plusPriceId("monthly");
    expect(productsCreate).toHaveBeenCalledTimes(1);
    expect(pricesCreate).toHaveBeenCalledTimes(1);
  });

  it("pages through products before giving up on finding ours", async () => {
    setProducts([
      [{ id: "prod_a", active: true, metadata: {} }],
      [{ id: "prod_plus", active: true, metadata: { hearth_plan: "plus" } }],
    ]);
    setPrices([]);
    await plusPriceId("monthly");
    expect(productsList).toHaveBeenCalledTimes(2);
    expect(productsList.mock.calls[1][0]).toMatchObject({
      starting_after: "prod_a",
    });
    expect(productsCreate).not.toHaveBeenCalled();
  });
});

describe("the extra-home add-on prices by volume tier", () => {
  it("charges the tier unit price for the quantity asked for", async () => {
    setProducts([
      [{ id: "prod_slots", active: true, metadata: { hearth_plan: "home_slots" } }],
    ]);
    await homeSlotPriceId("yearly", 3);
    expect(pricesCreate.mock.calls[0][0]).toMatchObject({
      unit_amount: Math.round(extraHomeUnitPrice("yearly", 3) * 100),
      recurring: { interval: "year" },
      product: "prod_slots",
    });
  });
});
