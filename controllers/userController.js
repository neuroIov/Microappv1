const User = require('../models/User');
const Leaderboard = require('../models/Leaderboard');
const { verifyTelegramWebAppData } = require('../utils/telegramUtils');
const logger = require('../utils/logger');
const { calculateReferralReward } = require('../utils/referralUtils');


exports.authenticateTelegram = async (req, res) => {
  try {
    logger.info('Received authentication request');
    const { initData } = req.body;
    logger.debug('InitData:', initData);
    
    if (!initData) {
      logger.error('No initData provided');
      return res.status(400).json({ message: 'No Telegram data provided' });
    }

    if (!verifyTelegramWebAppData(initData)) {
      logger.error('Invalid Telegram data');
      return res.status(401).json({ message: 'Invalid Telegram data' });
    }

    const params = new URLSearchParams(initData);
    const userString = params.get('user');
    if (!userString) {
      logger.error('No user data found in initData');
      return res.status(400).json({ message: 'No user data found' });
    }

    const userData = JSON.parse(decodeURIComponent(userString));
    logger.debug('Parsed user data:', userData);

    let user = await User.findOneAndUpdate(
      { telegramId: userData.id },
      { 
        $set: { 
          username: userData.username,
          firstName: userData.first_name,
          lastName: userData.last_name,
          languageCode: userData.language_code,
          photoUrl: userData.photo_url
        },
        $setOnInsert: { telegramId: userData.id }
      },
      { new: true, upsert: true }
    );

    const token = user.generateAuthToken();

    logger.info(`User authenticated successfully: ${user.telegramId}`);
    res.json({
      token,
      user: {
        id: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        languageCode: user.languageCode,
        photoUrl: user.photoUrl,
        xp: user.xp
      }
    });
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed', details: error.message });
  }
};



exports.getProfile = async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.user.telegramId });
    if (!user) {
      logger.warn(`User not found: ${req.user.telegramId}`);
      return res.status(404).json({ message: 'User not found' });
    }
    logger.info(`Profile retrieved for user: ${user.telegramId}`);
    res.json(user);
  } catch (error) {
    logger.error(`Get profile error: ${error.message}`);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const updates = Object.keys(req.body);
    const allowedUpdates = ['username', 'avatarUrl', 'language', 'theme'];
    const isValidOperation = updates.every(update => allowedUpdates.includes(update));

    if (!isValidOperation) {
      logger.warn(`Invalid update attempt: ${req.user.telegramId}`);
      return res.status(400).json({ error: 'Invalid updates!' });
    }

    updates.forEach(update => req.user[update] = req.body[update]);
    await req.user.save();

    logger.info(`Profile updated: ${req.user.telegramId}`);
    res.json(req.user);
  } catch (error) {
    logger.error(`Update profile error: ${error.message}`);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

exports.claimDailyXP = async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.user.telegramId });
    if (!user) {
      logger.warn(`User not found for daily XP claim: ${req.user.telegramId}`);
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.canClaimDailyXP()) {
      const xpGained = 100;
      user.xp += xpGained;
      user.lastDailyClaimDate = new Date();
      user.checkInStreak += 1;
      await user.save();
      logger.info(`Daily XP claimed: ${user.telegramId}, XP gained: ${xpGained}`);
      res.json({ message: 'Daily XP claimed successfully', xpGained, newTotalXp: user.xp });
    } else {
      logger.warn(`Attempted to claim XP too soon: ${user.telegramId}`);
      res.status(400).json({ message: 'Daily XP already claimed' });
    }
  } catch (error) {
    logger.error(`Claim daily XP error: ${error.message}`);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};
const distributeReferralXP = async (userId, xpGained) => {
  try {
    const user = await User.findById(userId).populate('referredBy');
    if (!user || !user.referredBy) return;

    let currentReferrer = user.referredBy;
    let currentTier = 1;
    const tierPercentages = [0.1, 0.05, 0.025]; // 10%, 5%, 2.5%

    while (currentReferrer && currentTier <= 3) {
      const referralXP = Math.floor(xpGained * tierPercentages[currentTier - 1]);
      currentReferrer.xp += referralXP;
      
      // Update the referral document
      await Referral.findOneAndUpdate(
        { referrer: currentReferrer._id, referred: user._id },
        { $inc: { totalRewardsDistributed: referralXP } }
      );

      await currentReferrer.save();
      logger.info(`Distributed ${referralXP} XP to referrer ${currentReferrer._id} (Tier ${currentTier})`);

      currentReferrer = await User.findOne({ _id: currentReferrer.referredBy });
      currentTier++;
    }
  } catch (error) {
    logger.error(`Error distributing referral XP: ${error.message}`);
  }
};

exports.tap = async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.user.telegramId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const now = new Date();
    if (user.cooldownEndTime && now < user.cooldownEndTime) {
      logger.info(`Tap rejected due to cooldown: ${user.telegramId}`);
      return res.status(400).json({ 
        message: 'Cooling down', 
        cooldownEndTime: user.cooldownEndTime
      });
    }

    user.totalTaps += 1;
    const xpGained = user.computePower;
    user.xp += xpGained;
    user.compute += xpGained;
    user.lastTapTime = now;

    if (user.totalTaps % 500 === 0) {
      user.cooldownEndTime = new Date(now.getTime() + 10 * 1000); // 10 seconds cooldown
      logger.info(`Cooldown initiated for user: ${user.telegramId}`);
    }

    // Check for GPU upgrade
    if (user.xp >= (user.gpuLevel + 1) * 25000) {
      user.gpuLevel += 1;
      user.computePower += 1;
      logger.info(`GPU upgraded for user ${user.telegramId}. New level: ${user.gpuLevel}`);
    }

    // Update boost count
    if (user.xp % 2000 === 0) {
      user.boostCount += 1;
    }

    await user.save();

    // Distribute referral XP
    await distributeReferralXP(user._id, xpGained);

    // Update leaderboards (make sure you have the Leaderboard model imported)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay());
    const allTimeDate = new Date(2000, 0, 1);

    await Promise.all([
      Leaderboard.updateEntry('daily', today, user._id, user.username, user.compute),
      Leaderboard.updateEntry('weekly', weekStart, user._id, user.username, user.compute),
      Leaderboard.updateEntry('all-time', allTimeDate, user._id, user.username, user.computePower)
    ]);

    logger.info(`Successful tap: ${user.telegramId}`);
    res.json({ 
      message: 'Tap successful', 
      user: {
        xp: user.xp,
        compute: user.compute,
        totalTaps: user.totalTaps,
        computePower: user.computePower,
        gpuLevel: user.gpuLevel,
        cooldownEndTime: user.cooldownEndTime,
        boostCount: user.boostCount
      }
    });
  } catch (error) {
    logger.error(`Tap error: ${error.message}`);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};
exports.boost = async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.user.telegramId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.boostCount < 1) {
      return res.status(400).json({ message: 'No boost available' });
    }

    const now = new Date();
    const boostDuration = 10 * 1000; // 10 seconds
    const tapsPerSecond = 10; // Assuming 10 taps per second during boost
    const totalBoostTaps = tapsPerSecond * (boostDuration / 1000);

    user.boostCount -= 1;
    user.lastBoostTime = now;
    user.totalTaps += totalBoostTaps;
    const xpGained = totalBoostTaps * user.computePower;
    user.xp += xpGained;
    user.compute += xpGained;

    // Reset cooldown
    user.cooldownEndTime = null;

    await user.save();

    res.json({
      message: 'Boost activated',
      user: {
        xp: user.xp,
        compute: user.compute,
        totalTaps: user.totalTaps,
        boostCount: user.boostCount,
        lastBoostTime: user.lastBoostTime
      }
    });
  } catch (error) {
    logger.error(`Boost error: ${error.message}`);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

exports.getCooldownStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      logger.warn(`User not found for cooldown status: ${req.user._id}`);
      return res.status(404).json({ message: 'User not found' });
    }
    logger.info(`Cooldown status retrieved for user: ${user.telegramId}`);
    res.json({
      cooldownEndTime: user.cooldownEndTime,
      isCoolingDown: user.cooldownEndTime > Date.now()
    });
  } catch (error) {
    logger.error(`Get cooldown status error: ${error.message}`);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

exports.getDailyPoints = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      logger.warn(`User not found for daily points: ${req.user._id}`);
      return res.status(404).json({ message: 'User not found' });
    }
    logger.info(`Daily points retrieved for user: ${user.telegramId}`);
    res.json({ dailyPoints: user.dailyPoints });
  } catch (error) {
    logger.error(`Get daily points error: ${error.message}`);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

exports.upgradeGPU = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      logger.warn(`User not found for GPU upgrade: ${req.user._id}`);
      return res.status(404).json({ message: 'User not found' });
    }

    // Implement GPU upgrade logic here
    // This is a placeholder implementation
    user.computePower += 1;
    await user.save();

    logger.info(`GPU upgraded for user: ${user.telegramId}, New compute power: ${user.computePower}`);
    res.json({ message: 'GPU upgraded successfully', newComputePower: user.computePower });
  } catch (error) {
    logger.error(`Upgrade GPU error: ${error.message}`);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};


