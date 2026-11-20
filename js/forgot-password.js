document.addEventListener('DOMContentLoaded', function () {
    const forgotForm = document.getElementById('forgotForm');
    if (forgotForm) {
        forgotForm.addEventListener('submit', function (e) {
            e.preventDefault();
            const email = document.getElementById('forgotEmail').value.trim();
            const forgotAlert = document.getElementById('forgotSuccessAlert');

            // TODO: Trigger password reset email via backend/Firebase
            console.log('Password reset requested for:', email);

            forgotAlert.classList.remove('d-none');
            this.reset();
        });
    }
});