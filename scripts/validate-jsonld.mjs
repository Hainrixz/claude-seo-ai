#!/usr/bin/env node
// Extract and validate JSON-LD structured data. Backs M5 (schema), M16 (author/Org),
// M18 (Product), M19 (LocalBusiness), M13 (dates).
//
// Usage: node validate-jsonld.mjs --url https://example.com [--type Article] [--type Product]
//        node validate-jsonld.mjs --file ./page.html
// Exit codes: 0 ok · 1 usage (no/unreadable input) · 2 runtime (fetch failed)
//
// Offline check only: valid JSON, recognized @type, presence of required/recommended
// properties per the Tier-1 template. It does NOT confirm Google rich-result eligibility
// (that needs the Rich Results Test, Tier 1) — callers should mark that status `needs_api`.
//
// Nodes are flattened through @graph AND nested properties (lib/jsonld.mjs flattenNodes), so a
// Product's Offer/AggregateRating and an Article's Person author are validated too; each node
// carries `path` ("Product.offers[0]") and `depth` (0 = root or @graph member). A property whose
// value is "", null, [] or {} counts as missing and is also listed in `empty_properties`.

import { EXIT, isMain, runCli, loadInput, inputFailure, getJsonLd } from './lib/util.mjs';
import { flattenNodes, validateNode } from './lib/jsonld.mjs';

const ARTICLE = { required: ['headline', 'author', 'datePublished'], recommended: ['image', 'dateModified', 'publisher'] };
const LOCAL = { required: ['name', 'address'], recommended: ['telephone', 'openingHoursSpecification', 'geo', 'url', 'priceRange', 'image'] };
const SOFTWARE = { required: ['name', 'offers'], recommended: ['aggregateRating', 'applicationCategory', 'operatingSystem', 'review'] };

/** schema.org LocalBusiness subtypes that share the LocalBusiness template. */
export const LOCAL_BUSINESS_TYPES = Object.freeze([
  'LocalBusiness', 'AnimalShelter', 'AutomotiveBusiness', 'AutoDealer', 'AutoRepair', 'ChildCare', 'Dentist', 'DryCleaningOrLaundry',
  'EmergencyService', 'EmploymentAgency', 'EntertainmentBusiness', 'NightClub', 'FinancialService', 'AccountingService', 'InsuranceAgency',
  'FoodEstablishment', 'Bakery', 'BarOrPub', 'Brewery', 'CafeOrCoffeeShop', 'Distillery', 'FastFoodRestaurant', 'IceCreamShop', 'Restaurant', 'Winery',
  'GovernmentOffice', 'HealthAndBeautyBusiness', 'BeautySalon', 'DaySpa', 'HairSalon', 'HealthClub', 'NailSalon', 'TattooParlor',
  'HomeAndConstructionBusiness', 'Electrician', 'GeneralContractor', 'HVACBusiness', 'HousePainter', 'Locksmith', 'MovingCompany', 'Plumber', 'RoofingContractor',
  'InternetCafe', 'LegalService', 'Attorney', 'Notary', 'Library', 'LodgingBusiness', 'BedAndBreakfast', 'Campground', 'Hostel', 'Hotel', 'Motel', 'Resort',
  'MedicalBusiness', 'Dentist', 'Optician', 'Pharmacy', 'Physician', 'ProfessionalService', 'RadioStation', 'RealEstateAgent', 'RecyclingCenter',
  'SelfStorage', 'ShoppingCenter', 'SportsActivityLocation', 'GolfCourse', 'SkiResort', 'StadiumOrArena', 'Store', 'BikeStore', 'BookStore', 'ClothingStore',
  'ComputerStore', 'ConvenienceStore', 'DepartmentStore', 'ElectronicsStore', 'Florist', 'FurnitureStore', 'GardenStore', 'GroceryStore', 'HardwareStore',
  'HobbyShop', 'HomeGoodsStore', 'JewelryStore', 'LiquorStore', 'MensClothingStore', 'MobilePhoneStore', 'MovieRentalStore', 'MusicStore', 'OfficeEquipmentStore',
  'OutletStore', 'PawnShop', 'PetStore', 'ShoeStore', 'SportingGoodsStore', 'TireShop', 'ToyStore', 'WholesaleStore', 'TelevisionStation', 'TouristInformationCenter',
  'TravelAgency', 'VeterinaryCare',
]);

// Required (hard) and recommended (soft) properties per Tier-1 type.
export const SPEC = {
  Organization: { required: ['name'], recommended: ['url', 'logo', 'sameAs'] },
  WebSite: { required: ['name', 'url'], recommended: ['potentialAction'] },
  Article: ARTICLE,
  NewsArticle: ARTICLE,
  BlogPosting: ARTICLE,
  Person: { required: ['name'], recommended: ['sameAs', 'jobTitle'] },
  BreadcrumbList: { required: ['itemListElement'], recommended: [] },
  Product: { required: ['name'], recommended: ['image', 'offers', 'aggregateRating', 'brand'] },
  Offer: { required: ['price', 'priceCurrency'], recommended: ['availability', 'url'] },
  Review: { required: ['reviewRating'], recommended: ['author', 'itemReviewed'] },
  AggregateRating: { required: ['ratingValue'], recommended: ['reviewCount', 'ratingCount'] },
  VideoObject: { required: ['name', 'thumbnailUrl', 'uploadDate'], recommended: ['description', 'duration'] },
  Event: { required: ['name', 'startDate'], recommended: ['location', 'offers'] },
  SoftwareApplication: SOFTWARE,
  WebApplication: SOFTWARE,
  MobileApplication: SOFTWARE,
  VideoGame: SOFTWARE,
};
for (const t of LOCAL_BUSINESS_TYPES) SPEC[t] = LOCAL;

const DEPRECATED_RICHRESULT = ['FAQPage', 'HowTo']; // still valid schema, no Google rich result

function evaluateNode(entry) {
  const v = validateNode(entry.node, SPEC);
  return {
    valid_json: true,
    types: v.types,
    has_id: v.has_id,
    missing_required: v.missing_required,
    missing_recommended: v.missing_recommended,
    known_type: v.known_type,
    deprecated_richresult: v.types.some((t) => DEPRECATED_RICHRESULT.includes(t)),
    path: entry.path,
    depth: entry.depth,
    empty_properties: v.empty_properties,
  };
}

export async function main(args) {
  const input = await loadInput(args);
  const failed = inputFailure(input);
  if (failed) return failed;

  const blocks = getJsonLd(input.html);
  const nodes = [];
  for (const b of blocks) {
    if (!b.ok) { nodes.push({ valid_json: false, error: b.error, raw: b.raw.slice(0, 200), path: null, depth: 0 }); continue; }
    for (const entry of flattenNodes(b.data)) nodes.push(evaluateNode(entry));
  }

  // --type may be repeated (parseArgs yields an array); a bare --type is ignored.
  const wantedTypes = [].concat(args.type == null ? [] : args.type).filter((t) => typeof t === 'string');
  const wanted = wantedTypes.length ? nodes.filter((n) => (n.types || []).some((t) => wantedTypes.includes(t))) : nodes;

  const result = {
    source: input.source,
    finalUrl: input.finalUrl || args.url || null,
    blocks_found: blocks.length,
    invalid_json_blocks: blocks.filter((b) => !b.ok).length,
    nodes: wanted,
    nodes_total: nodes.filter((n) => n.valid_json).length,
    nodes_nested_count: nodes.filter((n) => n.valid_json && n.depth > 0).length,
    types_present: [...new Set(nodes.flatMap((n) => n.types || []))].sort(),
    deprecated_richresult_types_present: nodes.flatMap((n) => n.types || []).filter((t) => DEPRECATED_RICHRESULT.includes(t)),
  };
  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);
