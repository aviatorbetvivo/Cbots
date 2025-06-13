// server.js

// --- Dependências ---
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

// --- Configuração Inicial ---
const app = express();
const port = process.env.PORT || 3000;

// --- Configuração do Multer para Upload ---
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let uploadPath = '';
    if (req.originalUrl.includes('/api/user/deposit-request')) {
      uploadPath = 'uploads/deposits/';
    } else if (req.originalUrl.includes('/api/admin/approve-withdrawal')) {
      uploadPath = 'uploads/withdrawals/';
    } else {
      return cb(new Error("Rota de upload inválida"), null);
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// --- Schemas e Models do Mongoose ---
const UserSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
  balanceUSDT: { type: Number, default: 0 },
  bonusBalanceUSDT: { type: Number, default: 0 },
  referralLink: { type: String, required: true },
  referrerId: { type: String, index: true },
  isAdmin: { type: Boolean, default: false },
  qualifiedReferrals: { type: Number, default: 0 },
  hasMadeDeposit: { type: Boolean, default: false },
});
const User = mongoose.model('User', UserSchema);

const BotTypeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  cost: { type: Number, required: true },
  daily_profit: { type: Number, required: true },
  duration_days: { type: Number, required: true },
});
const BotType = mongoose.model('BotType', BotTypeSchema);

const ActiveBotSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  botTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotType', required: true },
  botName: { type: String, required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  status: { type: String, enum: ['active', 'expired'], default: 'active', index: true },
  totalProfit: { type: Number, default: 0 },
  dailyProfit: { type: Number, required: true },
});
const ActiveBot = mongoose.model('ActiveBot', ActiveBotSchema);

const TransactionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  type: { 
      type: String, 
      enum: [
          'deposit', 'withdrawal', 'bot_purchase', 'bot_profit', 
          'referral_first_buy_bonus', 'referral_profit_share', 
          'signup_bonus', 'referral_milestone_bonus'
      ], 
      required: true 
  },
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  description: { type: String, required: true },
  status: { type: String, enum: ['completed', 'pending', 'rejected'], default: 'completed' },
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

const BannerSchema = new mongoose.Schema({
  title: { type: String, required: true },
  imageUrl: { type: String, required: true },
  linkUrl: String,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});
const Banner = mongoose.model('Banner', BannerSchema);

const PaymentMethodSchema = new mongoose.Schema({
    name: { type: String, required: true },
    address: { type: String, required: true, unique: true },
    qrCodeUrl: String,
    isActive: { type: Boolean, default: true },
});
const PaymentMethod = mongoose.model('PaymentMethod', PaymentMethodSchema);

const DepositRequestSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userEmail: { type: String, required: true },
  amount: { type: Number, required: true },
  paymentMethodId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentMethod', required: true },
  proofImageUrl: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  createdAt: { type: Date, default: Date.now },
  processedAt: Date,
  rejectionReason: String,
});
const DepositRequest = mongoose.model('DepositRequest', DepositRequestSchema);

const WithdrawalRequestSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    userEmail: { type: String, required: true },
    amount: { type: Number, required: true },
    walletAddress: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    adminProofImageUrl: String,
    createdAt: { type: Date, default: Date.now },
    processedAt: Date,
    rejectionReason: String,
});
const WithdrawalRequest = mongoose.model('WithdrawalRequest', WithdrawalRequestSchema);

const NotificationSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    link: String,
    isRead: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
});
const Notification = mongoose.model('Notification', NotificationSchema);


// --- Middlewares, Helpers e Configurações Globais ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static('public'));

// Helper para criar notificações
async function createNotification(userId, title, message, link = null) {
    try {
        const notification = new Notification({ userId, title, message, link });
        await notification.save();
    } catch (error) {
        console.error("Falha ao criar notificação:", error);
    }
}

// NOVO Middleware de Autenticação Simplificado
const authMiddleware = async (req, res, next) => {
    const uid = req.headers['x-user-uid'];
    if (!uid) return res.status(401).send({ error: 'UID de usuário não fornecido.' });
    
    const userExists = await User.findOne({ uid: uid });
    if (!userExists) return res.status(403).send({ error: 'Usuário não encontrado ou inválido.' });

    req.user = { uid: uid, email: userExists.email }; // Anexa uid e email
    next();
};

const adminMiddleware = async (req, res, next) => {
    const user = await User.findOne({ uid: req.user.uid });
    if (!user || !user.isAdmin) {
      return res.status(403).send({ error: 'Acesso negado. Rota exclusiva para administradores.' });
    }
    next();
};

// --- ROTAS PÚBLICAS ---
app.post('/api/create-db-user', async (req, res) => {
    const { email, uid, referralCode } = req.body;
    if (!email || !uid) return res.status(400).send({ error: 'E-mail e UID são obrigatórios.' });

    try {
        if (await User.findOne({ uid: uid })) {
            return res.status(409).send({ error: 'Usuário já existe no banco de dados.' });
        }

        const newUser = new User({
            uid, email,
            referralLink: `${req.protocol}://${req.get('host')}/registro.html?ref=${uid}`,
            bonusBalanceUSDT: 1.0,
        });

        if (referralCode) {
            const referrer = await User.findOne({ uid: referralCode });
            if (referrer) newUser.referrerId = referrer.uid;
        }

        await newUser.save();
        
        await Transaction.create({
            userId: uid, type: 'signup_bonus', amount: 1.0, description: 'Bônus de boas-vindas'
        });
        await createNotification(uid, "Bem-vindo!", "Você ganhou 1 USDT de bônus para começar!");

        res.status(201).send({ message: 'Usuário criado no banco de dados com sucesso.' });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// --- ROTAS DO USUÁRIO ---
const userRouter = express.Router();
userRouter.use(authMiddleware);

userRouter.post('/deposit-request', upload.single('proofImage'), async (req, res) => {
    const { amount, paymentMethodId } = req.body;
    if (!req.file) return res.status(400).send({ error: "O comprovante de pagamento é obrigatório." });
    if (!amount || !paymentMethodId) return res.status(400).send({ error: "Valor e método de pagamento são obrigatórios." });

    const deposit = new DepositRequest({
        userId: req.user.uid,
        userEmail: req.user.email,
        amount: parseFloat(amount),
        paymentMethodId,
        proofImageUrl: req.file.path
    });
    await deposit.save();
    await createNotification(req.user.uid, "Depósito em Revisão", `Sua solicitação de depósito de ${amount} USDT está sendo analisada.`);
    res.status(201).send({ message: "Sua solicitação de depósito foi enviada e está aguardando aprovação." });
});

userRouter.post('/withdrawal-request', async (req, res) => {
    const { amount, walletAddress } = req.body;
    if (!amount || !walletAddress) return res.status(400).send({ error: "Valor e endereço da carteira são obrigatórios." });
    
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
        const user = await User.findOne({ uid: req.user.uid }).session(session);
        if (!user || user.balanceUSDT < parseFloat(amount)) throw new Error("Saldo insuficiente para este saque.");

        user.balanceUSDT -= parseFloat(amount);
        await user.save({ session });
        
        const withdrawal = new WithdrawalRequest({
            userId: req.user.uid, userEmail: req.user.email, amount: parseFloat(amount), walletAddress
        });
        await withdrawal.save({ session });
        
        await Transaction.create({
            userId: req.user.uid, type: 'withdrawal', amount: -parseFloat(amount), description: `Solicitação de saque para ${walletAddress}`, status: 'pending'
        });
        
        await session.commitTransaction();
        
        await createNotification(req.user.uid, "Saque em Processamento", `Sua solicitação de saque de ${amount} USDT foi registrada.`);
        res.status(201).send({ message: "Sua solicitação de saque foi enviada com sucesso." });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).send({ error: error.message });
    } finally {
        session.endSession();
    }
});

userRouter.get('/notifications', async (req, res) => {
    const notifications = await Notification.find({ userId: req.user.uid }).sort({ createdAt: -1 }).limit(50);
    res.status(200).send(notifications);
});

userRouter.post('/notifications/mark-read', async (req, res) => {
    await Notification.updateMany({ userId: req.user.uid, isRead: false }, { $set: { isRead: true } });
    res.status(200).send({ message: 'Notificações marcadas como lidas.' });
});

app.use('/api/user', userRouter);

// Dentro do seu server.js, na seção de userRouter

userRouter.get('/dashboard-data', async (req, res) => {
    try {
        const user = await User.findOne({ uid: req.user.uid }).select('-__v');
        if (!user) {
            return res.status(404).send({ error: 'Usuário não encontrado.' });
        }
        
        const activeBots = await ActiveBot.find({ userId: req.user.uid, status: 'active' });

        res.status(200).send({
            user: user,
            activeBots: activeBots
        });

    } catch (error) {
        console.error("Erro ao buscar dados do dashboard:", error);
        res.status(500).send({ error: "Erro interno do servidor." });
    }
});


// --- ROTAS DO ADMINISTRADOR ---
const adminRouter = express.Router();
adminRouter.use(authMiddleware, adminMiddleware);

adminRouter.get('/pending-deposits', async (req, res) => {
    const deposits = await DepositRequest.find({ status: 'pending' }).sort({ createdAt: 1 });
    res.status(200).send(deposits);
});

adminRouter.get('/pending-withdrawals', async (req, res) => {
    const withdrawals = await WithdrawalRequest.find({ status: 'pending' }).sort({ createdAt: 1 });
    res.status(200).send(withdrawals);
});

adminRouter.post('/approve-deposit/:id', async (req, res) => {
    const { id } = req.params;
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const deposit = await DepositRequest.findById(id).session(session);
        if (!deposit || deposit.status !== 'pending') throw new Error("Solicitação não encontrada ou já processada.");
        
        deposit.status = 'approved';
        deposit.processedAt = new Date();
        
        const user = await User.findOne({ uid: deposit.userId }).session(session);
        if (!user) throw new Error("Usuário não encontrado.");
        
        user.balanceUSDT += deposit.amount;

        if (!user.hasMadeDeposit && user.referrerId) {
            const referrer = await User.findOne({ uid: user.referrerId }).session(session);
            if(referrer) {
                referrer.qualifiedReferrals += 1;
                await createNotification(referrer.uid, "Indicado Qualificado!", `Seu indicado ${user.email} fez o primeiro depósito.`);
                
                const milestone = Math.floor(referrer.qualifiedReferrals / 100) * 100;
                if (milestone > 0 && referrer.qualifiedReferrals % 100 === 0) {
                    const bonusAmount = (milestone / 100) * 15;
                    referrer.balanceUSDT += bonusAmount;
                    await Transaction.create({
                        userId: referrer.uid, type: 'referral_milestone_bonus', amount: bonusAmount, description: `Bônus por atingir ${milestone} indicações.`
                    });
                    await createNotification(referrer.uid, "Meta Atingida!", `Parabéns! Você ganhou ${bonusAmount} USDT por ${milestone} indicações.`);
                }
                await referrer.save({ session });
            }
        }
        user.hasMadeDeposit = true;
        await user.save({ session });
        await deposit.save({ session });

        await Transaction.create({
            userId: deposit.userId, type: 'deposit', amount: deposit.amount, description: 'Depósito aprovado'
        });

        await session.commitTransaction();
        await createNotification(deposit.userId, "Depósito Aprovado!", `Seu depósito de ${deposit.amount} USDT foi creditado.`);
        res.status(200).send({ message: "Depósito aprovado com sucesso." });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).send({ error: error.message });
    } finally {
        session.endSession();
    }
});

adminRouter.post('/approve-withdrawal/:id', upload.single('adminProofImage'), async (req, res) => {
    const { id } = req.params;
    if (!req.file) return res.status(400).send({ error: "O comprovante de envio é obrigatório." });

    const withdrawal = await WithdrawalRequest.findById(id);
    if (!withdrawal || withdrawal.status !== 'pending') throw new Error("Solicitação de saque não encontrada ou já processada.");

    withdrawal.status = 'approved';
    withdrawal.processedAt = new Date();
    withdrawal.adminProofImageUrl = req.file.path;
    await withdrawal.save();

    await Transaction.updateOne(
        { type: 'withdrawal', userId: withdrawal.userId, status: 'pending', amount: -withdrawal.amount },
        { $set: { status: 'completed' } }
    );
    
    await createNotification(withdrawal.userId, "Saque Aprovado", `Seu saque de ${withdrawal.amount} USDT foi enviado.`);
    res.status(200).send({ message: "Saque aprovado com sucesso." });
});

adminRouter.post('/reject-request/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const { reason } = req.body;
    if (!reason) return res.status(400).send({ error: 'O motivo da rejeição é obrigatório.' });

    const Model = type === 'deposit' ? DepositRequest : WithdrawalRequest;
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const request = await Model.findById(id).session(session);
        if (!request || request.status !== 'pending') throw new Error("Solicitação não encontrada ou já processada.");
        
        request.status = 'rejected';
        request.processedAt = new Date();
        request.rejectionReason = reason;
        
        if (type === 'withdrawal') {
            await User.updateOne({ uid: request.userId }, { $inc: { balanceUSDT: request.amount } }).session(session);
            await Transaction.updateOne(
                { type: 'withdrawal', userId: request.userId, status: 'pending', amount: -request.amount },
                { $set: { status: 'rejected', description: `Saque rejeitado: ${reason}` } }
            );
        }

        await request.save({ session });
        await session.commitTransaction();
        await createNotification(request.userId, `Sua solicitação de ${type} foi rejeitada`, `Motivo: ${reason}`);
        res.status(200).send({ message: `Solicitação de ${type} rejeitada.` });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).send({ error: error.message });
    } finally {
        session.endSession();
    }
});

app.use('/api/admin', adminRouter);


// --- CRON JOB e Inicialização do Servidor ---
cron.schedule('0 0 * * *', async () => { 
    console.log('--- Iniciando rotina de pagamento diário de lucros (Fuso: Africa/Maputo) ---');
    // ... (Lógica do cron job - buscar bots ativos, pagar lucros, etc.)
}, {
    scheduled: true,
    timezone: "Africa/Maputo"
});

mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => {
    console.log("Conectado ao MongoDB Atlas com sucesso!");
    app.listen(port, () => {
        console.log(`Servidor rodando na porta ${port}`);
    });
})
.catch(err => {
    console.error("Não foi possível conectar ao MongoDB Atlas.", err);
    process.exit(1);
});
