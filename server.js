// 1. IMPORTAÇÕES
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

// 2. CONFIGURAÇÃO INICIAL
const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 3. CONEXÃO COM O MONGODB
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => {
    console.log('✅ Conectado ao MongoDB Atlas');
}).catch(err => {
    console.error('❌ Erro ao conectar ao MongoDB:', err);
});

// 4. NODEMAILER TRANSPORTER
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// 5. CONFIGURAÇÃO DO MULTER
const proofStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/proofs/'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const uploadProof = multer({ storage: proofStorage });

const bannerStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/banners/'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const uploadBanner = multer({ storage: bannerStorage });


// 6. SCHEMAS E MODELS
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    isVerified: { type: Boolean, default: false },
    verificationToken: { type: String },
    status: { type: String, enum: ['active', 'blocked'], default: 'active' },
}, { timestamps: true });

const TransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['deposit', 'withdrawal', 'bonus', 'bot_purchase', 'bot_profit'], required: true },
    amount: { type: Number, required: true },
    description: { type: String },
}, { timestamps: true });

const DepositRequestSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    proofImageUrl: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

const BannerSchema = new mongoose.Schema({
    imageUrl: { type: String, required: true },
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);
const DepositRequest = mongoose.model('DepositRequest', DepositRequestSchema);
const Banner = mongoose.model('Banner', BannerSchema);


// 7. MIDDLEWARES DE AUTENTICAÇÃO
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

const isAdmin = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.id);
        if (user && user.role === 'admin') {
            next();
        } else {
            res.status(403).json({ message: 'Acesso restrito a administradores.' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Erro ao verificar permissões de admin.' });
    }
};


// 8. ROTAS DA API
// AUTENTICAÇÃO
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        if (!name || !email || !password) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
        let user = await User.findOne({ email });
        if (user) return res.status(400).json({ message: 'Este email já está em uso.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        user = new User({ name, email, password: hashedPassword, verificationToken });
        await user.save();

        const verificationUrl = `https://cbots.onrender.com/email-verification.html?token=${verificationToken}`;
        await transporter.sendMail({
            from: `"Sua Plataforma" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Verifique seu endereço de email',
            html: `<p>Olá ${name}, clique no link para verificar seu email: <a href="${verificationUrl}">Verificar Email</a></p>`,
        });

        res.status(201).json({ message: 'Registro bem-sucedido! Verifique seu email para ativar sua conta.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor.' });
    }
});

app.post('/api/auth/verify-email', async (req, res) => {
    const { token } = req.body;
    try {
        const user = await User.findOne({ verificationToken: token });
        if (!user) return res.status(400).json({ message: 'Token inválido ou expirado.' });
        
        const signupBonus = 5; // Bônus de 5 USDT
        user.isVerified = true;
        user.verificationToken = undefined;
        user.balance += signupBonus;
        await user.save();

        const bonusTransaction = new Transaction({ userId: user._id, type: 'bonus', amount: signupBonus, description: 'Bônus de Cadastro' });
        await bonusTransaction.save();
        res.status(200).json({ message: 'Email verificado com sucesso! Você ganhou 5 USDT e já pode fazer login.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ message: 'Credenciais inválidas.' });
        if (!user.isVerified) return res.status(403).json({ message: 'Por favor, verifique seu email.' });
        if (user.status === 'blocked') return res.status(403).json({ message: 'Sua conta foi bloqueada.' });

        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
        res.json({ token, user: { role: user.role } });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor.' });
    }
});

// USUÁRIO
app.get('/api/user/dashboard', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        const transactions = await Transaction.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(10);
        res.json({ user, transactions });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor' });
    }
});

app.post('/api/user/request-deposit', [authenticateToken, uploadProof.single('proofImage')], async (req, res) => {
    const { amount } = req.body;
    if (!req.file || !amount) return res.status(400).json({ message: 'Valor e comprovante são obrigatórios.' });

    try {
        const newDeposit = new DepositRequest({ userId: req.user.id, amount: Number(amount), proofImageUrl: req.file.path });
        await newDeposit.save();
        res.status(201).json({ message: 'Pedido de depósito enviado com sucesso!' });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor.' });
    }
});

// Rota pública para buscar banners
app.get('/api/banners', async (req, res) => {
    try {
        const banners = await Banner.find().sort({ createdAt: -1 });
        res.json(banners);
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor.' });
    }
});


// ADMIN
app.get('/api/admin/deposits/pending', [authenticateToken, isAdmin], async (req, res) => {
    try {
        const deposits = await DepositRequest.find({ status: 'pending' }).populate('userId', 'name email');
        res.json(deposits);
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor.' });
    }
});

app.post('/api/admin/deposits/approve', [authenticateToken, isAdmin], async (req, res) => {
    const { depositId } = req.body;
    try {
        const deposit = await DepositRequest.findById(depositId);
        if (!deposit || deposit.status !== 'pending') return res.status(404).json({ message: 'Pedido não encontrado ou já processado.' });

        const user = await User.findById(deposit.userId);
        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
        
        deposit.status = 'approved';
        user.balance += deposit.amount;
        const transaction = new Transaction({ userId: user._id, type: 'deposit', amount: deposit.amount, description: `Depósito aprovado (ID: ${deposit._id})`});
        
        await Promise.all([deposit.save(), user.save(), transaction.save()]);
        res.json({ message: `Depósito para ${user.email} aprovado!` });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor.' });
    }
});

app.post('/api/admin/deposits/reject', [authenticateToken, isAdmin], async (req, res) => {
    const { depositId } = req.body;
    try {
        const deposit = await DepositRequest.findByIdAndUpdate(depositId, { status: 'rejected' });
        if (!deposit) return res.status(404).json({ message: 'Pedido não encontrado.' });
        res.json({ message: 'Pedido de depósito rejeitado.' });
    } catch(error) {
        res.status(500).json({ message: 'Erro no servidor.' });
    }
});

app.post('/api/admin/banners/upload', [authenticateToken, isAdmin, uploadBanner.single('bannerImage')], async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Arquivo de imagem é obrigatório.' });
    try {
        const newBanner = new Banner({ imageUrl: req.file.path });
        await newBanner.save();
        res.status(201).json({ message: 'Banner adicionado!', banner: newBanner });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor.' });
    }
});

app.post('/api/admin/banners/url', [authenticateToken, isAdmin], async (req, res) => {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ message: 'URL da imagem é obrigatória.' });
    try {
        const newBanner = new Banner({ imageUrl });
        await newBanner.save();
        res.status(201).json({ message: 'Banner adicionado!', banner: newBanner });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor.' });
    }
});


// 9. INICIAR O SERVIDOR
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
