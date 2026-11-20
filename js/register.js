document.addEventListener('DOMContentLoaded', function () {
    // Toggle password visibility
    document.querySelectorAll('.toggle-password-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const input = document.getElementById(this.getAttribute('data-target'));
            const icon = this.querySelector('i');
            if (!input || !icon) return;

            if (input.type === 'password') {
                input.type = 'text';
                icon.classList.replace('fa-eye', 'fa-eye-slash');
            } else {
                input.type = 'password';
                icon.classList.replace('fa-eye-slash', 'fa-eye');
            }
        });
    });

    // Handle Register Form Submission & Admin Verification Notice
    const registerForm = document.getElementById('registerForm');
    if (registerForm) {
        registerForm.addEventListener('submit', function (e) {
            e.preventDefault();
            const companyName = document.getElementById('companyName').value.trim();
            const email = document.getElementById('registerEmail').value.trim();
            const pass = document.getElementById('registerPassword').value;
            const confirm = document.getElementById('confirmPassword').value;
            const errorMsg = document.getElementById('passwordMatchError');
            const successAlert = document.getElementById('registerSuccessAlert');

            if (pass !== confirm) {
                errorMsg.classList.remove('d-none');
                successAlert.classList.add('d-none');
                successAlert.classList.remove('d-flex');
                return;
            }

            errorMsg.classList.add('d-none');
            successAlert.classList.remove('d-none');
            successAlert.classList.add('d-flex');

            // TODO: Send registration details to backend for admin verification
            console.log('Registration submitted (wait for admin verification):', { companyName, email });

            this.reset();
        });
    }

    // Handle Continue with Google
    const googleRegisterBtn = document.getElementById('googleRegisterBtn');
    if (googleRegisterBtn) {
        googleRegisterBtn.addEventListener('click', function () {
            // TODO: Trigger Google OAuth sign-up
            console.log('Continue with Google clicked (Register)');
        });
    }
});