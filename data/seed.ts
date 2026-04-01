import { Truck } from '@/types/truck';

export const seedTrucks: Truck[] = [
  {
    id: 'sunset-smoke',
    name: 'Sunset Smoke BBQ',
    cuisine: 'Texas BBQ',
    address: '1100 N Highland Ave, Los Angeles, CA',
    latitude: 34.0904,
    longitude: -118.3385,
    status: 'Open now',
    hoursLabel: 'Today 11:00 AM - 8:30 PM',
    nextStop: 'Tomorrow at Silver Lake Farmers Market, 10:00 AM',
    distance: '0.8 mi',
    description:
      'Slow-smoked brisket, sticky ribs, and a line that moves fast because the crew knows the lunch rush is serious.',
    coverNote: 'Hollywood lunch crowd favorite',
    accent: '#C95C31',
    menu: [
      { id: '1', name: 'Brisket Plate', price: '$18', tag: 'Best seller' },
      { id: '2', name: 'Burnt Ends Taco', price: '$6', tag: 'Limited' },
      { id: '3', name: 'Peach Slaw Cup', price: '$5' },
    ],
    reviews: [
      {
        id: 'r1',
        author: 'Cam',
        rating: 5,
        comment: 'Brisket was unreal and they posted the exact lot they were parked in.',
        createdAt: '2026-03-30T18:14:00.000Z',
      },
      {
        id: 'r2',
        author: 'Ari',
        rating: 4,
        comment: 'Worth the wait. The app made it easy to catch them before they moved.',
        createdAt: '2026-03-29T21:42:00.000Z',
      },
    ],
  },
  {
    id: 'golden-kogi',
    name: 'Golden Kogi Bowl',
    cuisine: 'Korean Fusion',
    address: '4333 W Sunset Blvd, Los Angeles, CA',
    latitude: 34.0973,
    longitude: -118.2834,
    status: 'Moving soon',
    hoursLabel: 'Today 12:00 PM - 7:00 PM',
    nextStop: 'Rolling to Echo Park at 7:30 PM',
    distance: '1.7 mi',
    description:
      'Korean short rib bowls, kimchi fries, and a bright yellow truck that regulars track like a concert date.',
    coverNote: 'Posting next stop in real time',
    accent: '#F4B544',
    menu: [
      { id: '4', name: 'Short Rib Bowl', price: '$16', tag: 'Popular' },
      { id: '5', name: 'Kimchi Fries', price: '$9' },
      { id: '6', name: 'Sesame Citrus Slaw', price: '$6' },
    ],
    reviews: [
      {
        id: 'r3',
        author: 'Jules',
        rating: 5,
        comment: 'Exactly why I wanted a truck app. Saw the move update and made it in time.',
        createdAt: '2026-03-31T00:08:00.000Z',
      },
    ],
  },
  {
    id: 'marina-verde',
    name: 'Marina Verde',
    cuisine: 'Plant-Based Mexican',
    address: '14101 Panay Way, Marina del Rey, CA',
    latitude: 33.9783,
    longitude: -118.4451,
    status: 'Open now',
    hoursLabel: 'Today 9:30 AM - 4:00 PM',
    nextStop: 'Friday at Venice Boardwalk, 9:00 AM',
    distance: '5.4 mi',
    description:
      'A coastal green truck serving jackfruit birria tacos, horchata cold brew, and a small but precise menu.',
    coverNote: 'Near the marina bike path',
    accent: '#2E7D57',
    menu: [
      { id: '7', name: 'Birria Taco Trio', price: '$15', tag: 'New' },
      { id: '8', name: 'Horchata Cold Brew', price: '$7' },
      { id: '9', name: 'Avocado Elote Cup', price: '$8' },
    ],
    reviews: [
      {
        id: 'r4',
        author: 'Mina',
        rating: 4,
        comment: 'Love that owners can post hours directly. No stale Instagram story hunting anymore.',
        createdAt: '2026-03-28T16:30:00.000Z',
      },
      {
        id: 'r5',
        author: 'Theo',
        rating: 5,
        comment: 'The birria tacos are excellent and the location pin was spot on.',
        createdAt: '2026-03-27T19:22:00.000Z',
      },
    ],
  },
];
