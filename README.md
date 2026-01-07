# Bondfires 🔥

A video sharing social app where users create "bondfires" (video posts) and others respond with their own videos to build meaningful connections.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Mobile Framework | React Native (Expo) |
| UI Components | Tamagui |
| State Management | Legend State |
| Backend/Database | Convex |
| Authentication | Convex Auth |
| Navigation | Expo Router |
| Video Storage | AWS S3 |
| Video Processing | ffmpeg-kit-react-native |
| Monorepo | Turborepo |
| Package Manager | Bun |
| Infrastructure | Terraform |

## Repository Structure

```
bondfires/
├── apps/
│   └── mobile/              # Expo mobile app
├── packages/
│   ├── ui/                  # Shared Tamagui components
│   ├── app/                 # Features, hooks, Legend State stores
│   └── config/              # Tamagui configuration
├── convex/                  # Convex backend
├── infrastructure/          # Terraform for AWS
└── package.json
```

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [Node.js](https://nodejs.org/) >= 18
- iOS Simulator (Mac) or Android Emulator
- [Convex](https://convex.dev/) account

### Installation

```bash
# Clone the repository
git clone https://github.com/deggertsen/bondfires.git
cd bondfires

# Install dependencies
bun install

# Set up Convex
bunx convex dev
```

### Development

```bash
# Start the Expo dev server
cd apps/mobile
bun run start

# Or use Turborepo from root
bun run dev
```

### Environment Variables

Create a `.env.local` file in the root:

```env
EXPO_PUBLIC_CONVEX_URL=your-convex-deployment-url
```

## Features

- **Spark a Bondfire** - Record and share video posts
- **Respond to Bondfires** - Add video responses to existing posts
- **Algorithmic Feed** - Discover content ordered by engagement
- **User Profiles** - View and edit your profile
- **Push Notifications** - Stay updated on responses

## License

MIT

