require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Admin client for creating users (requires service role key)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

// Routes
app.get('/', (req, res) => {
  res.send('Hospital Management System API is running');
});

// Health check
app.get('/api/health', async (req, res) => {
  res.json({ status: 'ok', server_time: new Date() });
});

// --- Patient Routes ---

// GET /api/patients - Fetch all patients
app.get('/api/patients', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('patients')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/patients - Add a new patient
app.post('/api/patients', async (req, res) => {
  try {
    const { name, age, condition, status, contact_number, email } = req.body;
    const { data, error } = await supabase
      .from('patients')
      .insert([{ name, age, condition, status, contact_number, email }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Appointment Routes ---

// GET /api/appointments - Fetch all appointments
app.get('/api/appointments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select(`
        *,
        patients (name, contact_number)
      `)
      .order('appointment_date', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/appointments - Book appointment & Send Email
app.post('/api/appointments', async (req, res) => {
  try {
    const { patient_id, doctor_name, appointment_date, reason, patient_email } = req.body;

    // 1. Save to Supabase
    const { data: appointment, error: dbError } = await supabase
      .from('appointments')
      .insert([{ patient_id, doctor_name, appointment_date, reason }])
      .select()
      .single();

    if (dbError) throw dbError;

    // 2. Send Email via Resend
    try {
      if (process.env.RESEND_API_KEY) {
        await resend.emails.send({
          from: 'onboarding@resend.dev',
          to: 'delivered@resend.dev',
          subject: 'Appointment Confirmation',
          html: `
            <h1>Appointment Confirmed</h1>
            <p>Your appointment with <strong>${doctor_name}</strong> is scheduled for <strong>${new Date(appointment_date).toLocaleString()}</strong>.</p>
            <p>Reason: ${reason}</p>
          `
        });
      }
    } catch (emailError) {
      console.error('Email sending failed:', emailError);
    }

    res.status(201).json(appointment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Doctor Routes ---
app.get('/api/doctors', async (req, res) => {
  try {
    const { data, error } = await supabase.from('doctors').select('*');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Public Booking Routes ---
app.post('/api/public/book', async (req, res) => {
  try {
    const { name, email, age, condition, contact_number, doctor_name, doctor_specialty, appointment_date, reason } = req.body;

    console.log('Booking Request:', { doctor_name, appointment_date });

    // 0. CLASH DETECTION
    const requestedTime = new Date(appointment_date);
    const thirtyMinsBefore = new Date(requestedTime.getTime() - 30 * 60000).toISOString();
    const thirtyMinsAfter = new Date(requestedTime.getTime() + 30 * 60000).toISOString();

    // Check conflicts
    const { data: conflicts, error: conflictError } = await supabase
      .from('appointments')
      .select('id')
      .eq('doctor_name', `${doctor_name} (${doctor_specialty})`)
      .gte('appointment_date', thirtyMinsBefore)
      .lte('appointment_date', thirtyMinsAfter);

    if (conflictError) throw conflictError;

    if (conflicts && conflicts.length > 0) {
      return res.status(409).json({ error: 'This time slot is already booked. Please choose another time.' });
    }

    // 1. Check if patient exists
    let patient_id;
    const { data: existingPatient, error: searchError } = await supabase
      .from('patients')
      .select('id')
      .eq('contact_number', contact_number)
      .maybeSingle();

    if (searchError) throw searchError;

    if (existingPatient) {
      patient_id = existingPatient.id;
    } else {
      // 2. Create Auth user with patient role
      const { password } = req.body;

      if (!password || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters long' });
      }

      const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // Auto-confirm email
        user_metadata: {
          role: 'patient',
          name
        }
      });

      if (authError) {
        console.error('Auth user creation failed:', authError);
        throw new Error('Failed to create user account: ' + authError.message);
      }

      console.log('Auth user created:', authUser.user.id);

      // 3. Create patient record
      const { data: newPatient, error: createError } = await supabase
        .from('patients')
        .insert([{ name, age, condition, contact_number, status: 'Outpatient', email }])
        .select()
        .single();

      if (createError) throw createError;
      patient_id = newPatient.id;
    }

    // 3. Create Appointment
    const { data: appointment, error: apptError } = await supabase
      .from('appointments')
      .insert([{
        patient_id,
        doctor_name: `${doctor_name} (${doctor_specialty})`,
        appointment_date,
        reason
      }])
      .select()
      .single();

    if (apptError) throw apptError;

    // 4. Send Confirmation Email
    try {
      if (process.env.RESEND_API_KEY) {
        await resend.emails.send({
          from: 'onboarding@resend.dev',
          to: 'delivered@resend.dev',
          subject: 'Appointment Confirmed',
          html: `
                    <h1>Appointment Confirmed</h1>
                    <p>Dear ${name},</p>
                    <p>Your appointment with <strong>${doctor_name}</strong> (${doctor_specialty}) is scheduled for <strong>${new Date(appointment_date).toLocaleString()}</strong>.</p>
                `
        });
      }
    } catch (e) { console.error('Email error:', e); }

    res.status(201).json({ success: true, appointment });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Dashboard Routes ---
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    // Parallel queries for efficiency
    const [patients, doctors, appointments, appointmentsToday] = await Promise.all([
      supabase.from('patients').select('*', { count: 'exact', head: true }),
      supabase.from('doctors').select('*', { count: 'exact', head: true }),
      supabase.from('appointments').select('*', { count: 'exact', head: true }),
      supabase.from('appointments')
        .select('*', { count: 'exact', head: true })
        .gte('appointment_date', new Date().toISOString().split('T')[0])
        .lt('appointment_date', new Date(new Date().setDate(new Date().getDate() + 1)).toISOString().split('T')[0])
    ]);

    res.json({
      totalPatients: patients.count || 0,
      totalDoctors: doctors.count || 0,
      totalAppointments: appointments.count || 0,
      appointmentsToday: appointmentsToday.count || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
