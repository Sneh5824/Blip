import { v4 as uuidv4 } from "uuid";

const GUEST_ID_KEY      = "ds_guestId";
const DISPLAY_NAME_KEY  = "ds_displayName";

const DISPLAY_NAMES = [
  // Marvel Universe — adverb + name
  "Bravely Stark",
  "Swiftly Rogers",
  "Boldly Romanoff",
  "Quietly Banner",
  "Wisely Thor",
  "Calmly Barton",
  "Vividly Parker",
  "Nimbly Strange",
  "Boldly Wanda",
  "Steadily Vision",
  "Fiercely TChalla",
  "Quietly Shuri",
  "Brightly Okoye",
  "Firmly Rambeau",
  "Briskly Danvers",
  "Subtly Fury",
  "Patiently Hill",
  "Kindly Coulson",
  "Bravely Loki",
  "Neatly Valkyrie",
  "Smoothly Heimdall",
  "Nobly Frigga",
  "Quickly Mantis",
  "Freely Quill",
  "Safely Gamora",
  "Strongly Drax",
  "Lightly Rocket",
  "Warmly Groot",
  "Stealthily Nebula",
  "Clearly Yondu",
  "Finely Pepper",
  "Humbly Happy",
  "Brightly May",
  "Coolly Echo",
  "Steadily MoonKnight",
  "Quietly Khonshu",
  "Briskly ShangChi",
  "Gracefully Katy",
  "Patiently Wong",
  "Sharply Chavez",
  "Keenly AntMan",
  "Briskly Wasp",
  "Softly Yelena",
  "Smoothly RedGuardian",
  "Quickly Bucky",
  "Loyally SamWilson",
  "Strongly Isaiah",
  "Calmly Agatha",
  "Bravely Kamala",
  "Brightly KateBishop",
  "Firmly SheHulk",
  "Swiftly Daredevil",
  "Quietly Elektra",
  "Boldly Punisher",
  "Neatly Blade",
  "Silently SilverSurfer",
  "Clearly ReedRichards",
  "Bravely SueStorm",
  "Strongly BenGrimm",
  "Quickly JohnnyStorm",
];

/**
 * Returns the persisted guest identity.
 * - guestId     : stable (localStorage). It is a private credential — the server
 *                 uses it to recognise the host and never shows it to others.
 * - displayName : random per browser tab (sessionStorage), so a refresh keeps
 *                 your name but a new tab or visit gets a fresh one.
 */
export function getOrCreateIdentity() {
  if (typeof window === "undefined") return { guestId: "", displayName: "" };

  let guestId = localStorage.getItem(GUEST_ID_KEY);
  if (!guestId) {
    guestId = uuidv4();
    localStorage.setItem(GUEST_ID_KEY, guestId);
  }

  let displayName = sessionStorage.getItem(DISPLAY_NAME_KEY);
  if (!displayName) {
    displayName = DISPLAY_NAMES[Math.floor(Math.random() * DISPLAY_NAMES.length)];
    sessionStorage.setItem(DISPLAY_NAME_KEY, displayName);
  }

  return { guestId, displayName };
}
