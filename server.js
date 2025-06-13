// server.js

// --- Dependências ---
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  balanceUSDT: { type: Number, default: 0 },
  bonusBalanceUSDT: { type: Number, default: 0 },
  referralLink: { type: String },
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
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
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
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['deposit', 'withdrawal', 'bot_purchase', 'bot_profit', 'referral_first_buy_bonus', 'referral_profit_share', 'signup_bonus', 'referral_milestone_bonus'], required: true },
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
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
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
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true },
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
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    link: String,
    isRead: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
});
const Notification = mongoose.model('Notification', NotificationSchema);

// --- Middlewares e Helpers ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static('public'));

async function createNotification(userId, title, message, link = null) {
    try {
        await Notification.create({ userId, title, message, link });
    } catch (error) {
        console.error("Falha ao criar notificação:", error);
    }
}

// --- ROTAS DE AUTENTICAÇÃO ---
const authRouter = express.Router();

authRouter.post('/register', async (req, res) => {
    const { email, password, referralCode } = req.body;
    if (!email || !password || password.length < 6) return res.status(400).send({ error: "E-mail e senha (mínimo 6 caracteres) são obrigatórios." });

    try {
        if (await User.findOne({ email })) return res.status(409).send({ error: "Este e-mail já está em uso." });

        const hashedPassword = await bcrypt.hash(password, 12);
        const newUser = new User({ email, password: hashedPassword, bonusBalanceUSDT: 1.0 });
        newUser.referralLink = `${req.protocol}://${req.get('host')}/registro.html?ref=${newUser._id}`;

        if (referralCode) {
            const referrer = await User.findById(referralCode).catch(() => null);
            if (referrer) newUser.referrerId = referrer._id.toString();
        }
        await newUser.save();
        await Transaction.create({ userId: newUser._id, type: 'signup_bonus', amount: 1.0, description: 'Bônus de boas-vindas' });
        await createNotification(newUser._id, "Bem-vindo!", "Você ganhou 1 USDT de bônus para começar!");
        
        res.status(201).send({ message: "Usuário registrado com sucesso!" });
    } catch (error) {
        res.status(500).send({ error: "Erro interno do servidor." });
    }
});

authRouter.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).send({ error: "E-mail e senha são obrigatórios." });

    try {
        const user = await User.findOne({ email });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).send({ error: "Credenciais inválidas." });
        }
        
        const token = jwt.sign(
            { userId: user._id, email: user.email, isAdmin: user.isAdmin },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.status(200).send({ token, userId: user._id });
    } catch (error) {
        res.status(500).send({ error: "Erro interno do servidor." });
    }
});
app.use('/api/auth', authRouter);

// --- MIDDLEWARE DE AUTENTICAÇÃO COM JWT ---
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).send({ error: "Acesso negado. Nenhum token fornecido." });
    
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = { userId: decoded.userId, email: decoded.email, isAdmin: decoded.isAdmin };
        next();
    } catch (error) {
        return res.status(401).send({ error: "Token inválido ou expirado." });
    }
};

const adminMiddleware = (req, res, next) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).send({ error: "Acesso negado. Rota de administrador." });
    next();
};

// --- ROTAS DO USUÁRIO ---
const userRouter = express.Router();
userRouter.use(authMiddleware);

userRouter.get('/dashboard-data', async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('-password -__v');
        if (!user) return res.status(404).send({ error: 'Usuário não encontrado.' });
        
        const activeBots = await ActiveBot.find({ userId: user._id, status: 'active' });
        res.status(200).send({ user, activeBots });
    } catch (error) {
        res.status(500).send({ error: "Erro interno do servidor." });
    }
});

userRouter.post('/deposit-request', upload.single('proofImage'), async (req, res) => {
    const { amount, paymentMethodId } = req.body;
    if (!req.file || !amount || !paymentMethodId) return res.status(400).send({ error: "Campos e comprovante são obrigatórios." });

    const deposit = new DepositRequest({
        userId: req.user.userId,
        userEmail: req.user.email,
        amount: parseFloat(amount),
        paymentMethodId,
        proofImageUrl: req.file.path
    });
    await deposit.save();
    await createNotification(req.user.userId, "Depósito em Revisão", `Sua solicitação de depósito de ${amount} USDT está sendo analisada.`);
    res.status(201).send({ message: "Solicitação de depósito enviada." });
});

userRouter.post('/withdrawal-request', async (req, res) => {
    const { amount, walletAddress } = req.body;
    if (!amount || !walletAddress) return res.status(400).send({ error: "Valor e endereço da carteira são obrigatórios." });
    
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const user = await User.findById(req.user.userId).session(session);
        if (!user || user.balanceUSDT < parseFloat(amount)) throw new Error("Saldo insuficiente.");

        user.balanceUSDT -= parseFloat(amount);
        
        const newTransaction = new Transaction({ userId: user._id, type: 'withdrawal', amount: -parseFloat(amount), description: `Solicitação de saque para ${walletAddress}`, status: 'pending' });
        
        const withdrawal = new WithdrawalRequest({ userId: user._id, transactionId: newTransaction._id, userEmail: user.email, amount: parseFloat(amount), walletAddress });

        await user.save({ session });
        await newTransaction.save({ session });
        await withdrawal.save({ session });
        
        await session.commitTransaction();
        await createNotification(user._id, "Saque em Processamento", `Sua solicitação de saque de ${amount} USDT foi registrada.`);
        res.status(201).send({ message: "Solicitação de saque enviada." });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).send({ error: error.message });
    } finally {
        session.endSession();
    }
});

userRouter.get('/notifications', async (req, res) => {
    const notifications = await Notification.find({ userId: req.user.userId }).sort({ createdAt: -1 }).limit(50);
    res.status(200).send(notifications);
});

userRouter.post('/notifications/mark-read', async (req, res) => {
    await Notification.updateMany({ userId: req.user.userId, isRead: false }, { $set: { isRead: true } });
    res.status(200).send({ message: 'Notificações marcadas como lidas.' });
});
app.use('/api/user', userRouter);

// --- ROTAS DO ADMINISTRADOR ---
const adminRouter = express.Router();
adminRouter.use(authMiddleware, adminMiddleware);

adminRouter.get('/pending-deposits', async (req, res) => {
    const deposits = await DepositRequest.find({ status: 'pending' }).populate('userId', 'email').sort({ createdAt: 1 });
    res.status(200).send(deposits);
});

adminRouter.get('/pending-withdrawals', async (req, res) => {
    const withdrawals = await WithdrawalRequest.find({ status: 'pending' }).populate('userId', 'email').sort({ createdAt: 1 });
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
        
        const user = await User.findById(deposit.userId).session(session);
        if (!user) throw new Error("Usuário não encontrado.");
        
        user.balanceUSDT += deposit.amount;

        if (!user.hasMadeDeposit && user.referrerId) {
            const referrer = await User.findById(user.referrerId).session(session);
            if(referrer) {
                referrer.qualifiedReferrals += 1;
                const milestone = Math.floor(referrer.qualifiedReferrals / 100) * 100;
                if (milestone > 0 && referrer.qualifiedReferrals % 100 === 0) {
                    const bonusAmount = (milestone / 100) * 15;
                    referrer.balanceUSDT += bonusAmount;
                    await Transaction.create([{ userId: referrer._id, type: 'referral_milestone_bonus', amount: bonusAmount, description: `Bônus por ${milestone} indicações.` }], { session });
                    await createNotification(referrer._id, "Meta Atingida!", `Parabéns! Você ganhou ${bonusAmount} USDT.`);
                }
                await createNotification(referrer._id, "Indicado Qualificado!", `${user.email} fez o primeiro depósito.`);
                await referrer.save({ session });
            }
        }
        user.hasMadeDeposit = true;
        await user.save({ session });
        await deposit.save({ session });
        await Transaction.create([{ userId: deposit.userId, type: 'deposit', amount: deposit.amount, description: 'Depósito aprovado' }], { session });

        await session.commitTransaction();
        await createNotification(deposit.userId, "Depósito Aprovado!", `Seu depósito de ${deposit.amount} USDT foi creditado.`);
        res.status(200).send({ message: "Depósito aprovado." });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).send({ error: error.message });
    } finally {
        session.endSession();
    }
});

adminRouter.post('/approve-withdrawal/:id', upload.single('adminProofImage'), async (req, res) => {
    const { id } = req.params;
    if (!req.file) return res.status(400).send({ error: "O comprovante é obrigatório." });

    const withdrawal = await WithdrawalRequest.findById(id);
    if (!withdrawal || withdrawal.status !== 'pending') throw new Error("Solicitação de saque não encontrada ou já processada.");

    withdrawal.status = 'approved';
    withdrawal.processedAt = new Date();
    withdrawal.adminProofImageUrl = req.file.path;
    await withdrawal.save();

    await Transaction.findByIdAndUpdate(withdrawal.transactionId, { $set: { status: 'completed' } });
    await createNotification(withdrawal.userId, "Saque Aprovado", `Seu saque de ${withdrawal.amount} USDT foi enviado.`);
    res.status(200).send({ message: "Saque aprovado." });
});

adminRouter.post('/reject-request/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const { reason } = req.body;
    if (!reason) return res.status(400).send({ error: 'O motivo é obrigatório.' });

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
            await User.findByIdAndUpdate(request.userId, { $inc: { balanceUSDT: request.amount } }, { session });
            await Transaction.findByIdAndUpdate(request.transactionId, { $set: { status: 'rejected', description: `Saque rejeitado: ${reason}` } });
        }

        await request.save({ session });
        await session.commitTransaction();
        await createNotification(request.userId, `Solicitação de ${type} rejeitada`, `Motivo: ${reason}`);
        res.status(200).send({ message: `Solicitação de ${type} rejeitada.` });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).send({ error: error.message });
    } finally {
        session.endSession();
    }
});

adminRouter.get('/users', async (req, res) => {
    const users = await User.find({}).select('-password');
    res.status(200).send(users);
});
app.use('/api/admin', adminRouter);

// --- CRON JOB ---
cron.schedule('0 0 * * *', async () => { 
    console.log('--- Iniciando rotina de pagamento diário de lucros (Fuso: Africa/Maputo) ---');
    // Adicione a lógica do cron job aqui
}, { scheduled: true, timezone: "Africa/Maputo" });

// --- Inicialização do Servidor ---
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
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