import { redirect } from "next/navigation";
import { formatAddressLine, getActiveProperty } from "@/lib/property";
import HomeDetailsForm from "./HomeDetailsForm";
import Breadcrumbs from "@/components/Breadcrumbs";

export default async function HomeDetailsPage() {
  const property = await getActiveProperty();
  if (!property) redirect("/onboarding");

  const cityState = [property.city, property.state].filter(Boolean).join(", ");

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <Breadcrumbs items={[{ label: "Home", href: "/dashboard" }, { label: "Home details" }]} />
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Home details
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          {formatAddressLine(property)}
          {cityState ? `, ${cityState}` : ""}
          {property.zip ? ` ${property.zip}` : ""}
        </p>
      </header>

      <p className="mb-5 text-sm text-stone-500 dark:text-stone-400">
        These are the basic facts about your home. Fix anything that&apos;s
        wrong, or fill in what&apos;s missing - they show up on your home
        report and feed your cost forecast and value estimate. Leave a box
        blank to leave it as it is.
      </p>

      <HomeDetailsForm
        propertyType={property.property_type}
        yearBuilt={property.year_built}
        sqft={property.sqft}
        beds={property.beds}
        baths={property.baths}
        lotSizeSqft={property.lot_size_sqft}
        purchaseDate={property.purchase_date}
      />
    </div>
  );
}
