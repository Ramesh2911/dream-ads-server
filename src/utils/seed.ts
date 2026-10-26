import bcrypt from 'bcryptjs';
import { connectDB, disconnectDB } from '../config/database';
import { Role, ALL_PERMISSIONS } from '../models/Role';
import { AdminUser } from '../models/AdminUser';
import { User } from '../models/User';
import { Wallet } from '../models/Wallet';
import { Category } from '../models/Category';
import { Video } from '../models/Video';
import { Task } from '../models/Task';
import { ReferralConfig } from '../models/ReferralConfig';
import { Banner } from '../models/Banner';
import { Setting } from '../models/Setting';
import { Voucher } from '../models/Voucher';

async function seed() {
  await connectDB();
  console.log('Seeding...');

  // Roles
  const superRole = await Role.findOneAndUpdate(
    { name: 'Super Admin' },
    { name: 'Super Admin', permissions: ALL_PERMISSIONS, isSystem: true },
    { upsert: true, new: true }
  );
  const opsRole = await Role.findOneAndUpdate(
    { name: 'Operations' },
    {
      name: 'Operations',
      permissions: ['dashboard.view', 'users.read', 'users.update', 'tasks.read', 'tasks.verify', 'finance.read', 'reports.read', 'leads.read', 'leads.manage'],
      isSystem: true,
    },
    { upsert: true, new: true }
  );

  // Admin users
  const superPass = await bcrypt.hash('Admin@123', 10);
  await AdminUser.findOneAndUpdate(
    { email: 'super@dreamads.com' },
    { email: 'super@dreamads.com', password: superPass, name: 'Super Admin', role: superRole._id, status: 'active', totpEnabled: false },
    { upsert: true }
  );
  await AdminUser.findOneAndUpdate(
    { email: 'ops@dreamads.com' },
    { email: 'ops@dreamads.com', password: superPass, name: 'Ops Manager', role: opsRole._id, status: 'active' },
    { upsert: true }
  );

  // Categories
  const cats = [
    { name: 'Entertainment', slug: 'entertainment', order: 1 },
    { name: 'Education', slug: 'education', order: 2 },
    { name: 'Sports', slug: 'sports', order: 3 },
    { name: 'Tech', slug: 'tech', order: 4 },
  ];
  for (const c of cats) {
    await Category.findOneAndUpdate({ slug: c.slug }, c, { upsert: true });
  }
  const entCat = await Category.findOne({ slug: 'entertainment' });

  // Sample videos
  const videoCount = await Video.countDocuments();
  if (videoCount === 0 && entCat) {
    await Video.insertMany([
      {
        title: 'Welcome to Dream Ads', description: 'Intro video', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
        thumbnail: 'https://images.unsplash.com/photo-1611162616475-46b635cb6868?w=800', category: entCat._id, duration: 60,
        rewardCoins: 10, rewardWallet: 'video', status: 'published', isFeatured: true, isTrending: true,
      },
      {
        title: 'Daily Earning Tips', description: 'Learn how to maximize rewards', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
        thumbnail: 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=800', category: entCat._id, duration: 45,
        rewardCoins: 8, rewardWallet: 'video', status: 'published', isFeatured: true,
      },
      {
        title: 'Fun Challenges Compilation', description: 'Best challenges', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
        thumbnail: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=800', category: entCat._id, duration: 30,
        rewardCoins: 5, rewardWallet: 'video', status: 'published', isTrending: true,
      },
    ]);
  }

  // Tasks
  const taskCount = await Task.countDocuments();
  if (taskCount === 0) {
    await Task.insertMany([
      {
        title: 'Follow us on Instagram', description: 'Follow @dreamads official and share screenshot',
        instructions: 'Open Instagram, search dreamads.official, follow, screenshot profile', proofType: 'screenshot',
        rewardCoins: 50, rewardWallet: 'social', status: 'active', totalSlots: 1000, createdBy: superRole._id,
      },
      {
        title: 'Visit Partner Website', description: 'Visit our partner and explore', instructions: 'Click the link, browse for 2 min',
        proofType: 'url', rewardCoins: 30, rewardWallet: 'social', status: 'active', totalSlots: 500, createdBy: superRole._id,
      },
    ]);
  }

  // Referral config
  await ReferralConfig.findOneAndUpdate(
    {},
    {
      maxLevels: 10,
      levelRewards: [
        { level: 1, coins: 100, wallet: 'social' },
        { level: 2, coins: 50, wallet: 'social' },
        { level: 3, coins: 25, wallet: 'social' },
      ],
      dailyJoinLimit: 100,
      commissionEnabled: false,
      commissionPercent: 0,
    },
    { upsert: true }
  );

  // Banners
  const bannerCount = await Banner.countDocuments();
  if (bannerCount === 0) {
    await Banner.insertMany([
      { title: 'Welcome Bonus — Get 100 coins', imageUrl: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=1200', targetUrl: 'https://dreamads.app/download', order: 1, isActive: true },
      { title: 'Refer & Earn Big', imageUrl: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=1200', targetUrl: 'https://dreamads.app/referral', order: 2, isActive: true },
    ]);
  }

  // Settings
  const settings: Record<string, unknown> = {
    appName: 'Dream Ads',
    androidDownloadUrl: 'https://play.google.com/store/apps/details.id=com.dreamads.app',
    iosDownloadUrl: '',
    minWithdrawal: 100,
    signupBonus: 0,
    maintenanceMode: false,
  };
  for (const [key, value] of Object.entries(settings)) {
    await Setting.findOneAndUpdate({ key }, { key, value }, { upsert: true });
  }

  // Vouchers
  const voucherCount = await Voucher.countDocuments();
  if (voucherCount === 0) {
    await Voucher.insertMany([
      { title: 'Mobile Recharge ₹50', provider: 'recharge', coinCost: 500, faceValue: 50, isActive: true, stock: 100 },
      { title: 'Gift Voucher ₹100', provider: 'voucher', coinCost: 1000, faceValue: 100, isActive: true, stock: 50 },
    ]);
  }

  console.log('Seed complete.');
  console.log('Admin logins: super@dreamads.com / Admin@123, ops@dreamads.com / Admin@123');
  await disconnectDB();
}

seed().catch((e) => { console.error(e); process.exit(1); });
